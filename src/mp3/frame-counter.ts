const MPEG_1_LAYER_3_BITRATES_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const;

const MPEG_1_SAMPLE_RATES_HZ = [44_100, 48_000, 32_000] as const;
const ID3_HEADER_LENGTH = 10;

export class Mp3ParseError extends Error {
  constructor(
    readonly code: 'INVALID_ID3_TAG' | 'NO_AUDIO_FRAMES' | 'TRUNCATED_AUDIO_FRAME',
    message: string,
  ) {
    super(message);
    this.name = 'Mp3ParseError';
  }
}

type FrameHeader = {
  frameLength: number;
  hasCrc: boolean;
  isMono: boolean;
};

/**
 * Counts MPEG-1 Audio Layer III frames while retaining at most a few frame-sized
 * chunks. ID3v2 metadata is skipped without buffering its payload.
 */
export class Mpeg1Layer3FrameCounter {
  private buffer: Buffer = Buffer.alloc(0);
  private frameCount = 0;
  private id3BytesRemaining = 0;
  private id3HeaderChecked = false;
  private audioSequenceStarted = false;
  private audioSequenceFinished = false;

  push(chunk: Uint8Array): void {
    if (this.audioSequenceFinished || chunk.byteLength === 0) {
      return;
    }

    let incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    if (this.id3BytesRemaining > 0) {
      const bytesToSkip = Math.min(this.id3BytesRemaining, incoming.length);
      this.id3BytesRemaining -= bytesToSkip;
      incoming = incoming.subarray(bytesToSkip);

      if (incoming.length === 0) {
        return;
      }
    }

    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    this.skipId3HeaderIfPresent();
    this.processAvailableFrames(false);
  }

  finish(): number {
    if (this.id3BytesRemaining > 0) {
      throw new Mp3ParseError('INVALID_ID3_TAG', 'The ID3v2 tag is truncated.');
    }

    this.skipId3HeaderIfPresent(true);
    this.processAvailableFrames(true);

    if (this.frameCount === 0) {
      throw new Mp3ParseError(
        'NO_AUDIO_FRAMES',
        'No valid MPEG-1 Audio Layer III frames were found.',
      );
    }

    if (this.audioSequenceStarted && !this.audioSequenceFinished) {
      const header = parseFrameHeader(this.buffer, 0);
      if (header && this.buffer.length < header.frameLength) {
        throw new Mp3ParseError(
          'TRUNCATED_AUDIO_FRAME',
          'The upload ends part-way through an MPEG audio frame.',
        );
      }
    }

    return this.frameCount;
  }

  private skipId3HeaderIfPresent(isFinal = false): void {
    if (this.id3HeaderChecked || this.id3BytesRemaining > 0) {
      return;
    }

    if (this.buffer.length < 3) {
      return;
    }

    const hasId3Header = this.buffer.subarray(0, 3).equals(Buffer.from('ID3'));
    if (!hasId3Header) {
      this.id3HeaderChecked = true;
      return;
    }

    if (this.buffer.length < ID3_HEADER_LENGTH) {
      if (isFinal) {
        throw new Mp3ParseError('INVALID_ID3_TAG', 'The ID3v2 header is truncated.');
      }
      return;
    }

    const sizeBytes = this.buffer.subarray(6, 10);
    if (sizeBytes.some((byte) => (byte & 0x80) !== 0)) {
      throw new Mp3ParseError('INVALID_ID3_TAG', 'The ID3v2 tag has an invalid size.');
    }

    const tagSize =
      (sizeBytes[0]! << 21) | (sizeBytes[1]! << 14) | (sizeBytes[2]! << 7) | sizeBytes[3]!;
    const hasFooter = (this.buffer[5]! & 0x10) !== 0;
    this.id3BytesRemaining = tagSize + (hasFooter ? ID3_HEADER_LENGTH : 0);
    this.buffer = this.buffer.subarray(ID3_HEADER_LENGTH);
    this.id3HeaderChecked = true;

    if (this.buffer.length > 0 && this.id3BytesRemaining > 0) {
      const bytesToSkip = Math.min(this.id3BytesRemaining, this.buffer.length);
      this.id3BytesRemaining -= bytesToSkip;
      this.buffer = this.buffer.subarray(bytesToSkip);
    }
  }

  private processAvailableFrames(isFinal: boolean): void {
    if (!this.id3HeaderChecked || this.id3BytesRemaining > 0 || this.audioSequenceFinished) {
      return;
    }

    if (!this.audioSequenceStarted) {
      this.findFirstFrame(isFinal);
    }

    while (this.audioSequenceStarted && !this.audioSequenceFinished && this.buffer.length >= 4) {
      const header = parseFrameHeader(this.buffer, 0);
      if (!header) {
        // MPEG audio frames are contiguous. Anything after the sequence is
        // treated as trailing metadata (for example an ID3v1 or APE tag).
        this.audioSequenceFinished = true;
        this.buffer = Buffer.alloc(0);
        return;
      }

      if (this.buffer.length < header.frameLength) {
        return;
      }

      this.frameCount += 1;
      this.buffer = this.buffer.subarray(header.frameLength);
    }
  }

  private findFirstFrame(isFinal: boolean): void {
    let offset = 0;

    while (this.buffer.length - offset >= 4) {
      const header = parseFrameHeader(this.buffer, offset);
      if (!header) {
        offset += 1;
        continue;
      }

      const nextFrameOffset = offset + header.frameLength;
      if (this.buffer.length < nextFrameOffset) {
        break;
      }

      const bytesAfterCandidate = this.buffer.length - nextFrameOffset;
      if (!isFinal && bytesAfterCandidate < 4) {
        break;
      }

      const followedByAnotherFrame = parseFrameHeader(this.buffer, nextFrameOffset) !== undefined;
      if (!followedByAnotherFrame && !(isFinal && bytesAfterCandidate === 0)) {
        offset += 1;
        continue;
      }

      const isMetadataFrame = containsVbrMetadata(this.buffer, offset, header);
      this.buffer = this.buffer.subarray(nextFrameOffset);
      if (!isMetadataFrame) {
        this.frameCount += 1;
      }
      this.audioSequenceStarted = true;
      return;
    }

    if (offset > 0) {
      this.buffer = this.buffer.subarray(offset);
    }
  }
}

export async function countMpeg1Layer3Frames(source: AsyncIterable<Uint8Array>): Promise<number> {
  const counter = new Mpeg1Layer3FrameCounter();

  for await (const chunk of source) {
    counter.push(chunk);
  }

  return counter.finish();
}

function parseFrameHeader(buffer: Uint8Array, offset: number): FrameHeader | undefined {
  if (buffer.length - offset < 4) {
    return undefined;
  }

  const byte1 = buffer[offset]!;
  const byte2 = buffer[offset + 1]!;
  const byte3 = buffer[offset + 2]!;
  const byte4 = buffer[offset + 3]!;

  const hasSyncWord = byte1 === 0xff && (byte2 & 0xe0) === 0xe0;
  const versionBits = (byte2 >> 3) & 0x03;
  const layerBits = (byte2 >> 1) & 0x03;
  const hasCrc = (byte2 & 0x01) === 0;
  const bitrateIndex = (byte3 >> 4) & 0x0f;
  const sampleRateIndex = (byte3 >> 2) & 0x03;
  const padding = (byte3 >> 1) & 0x01;
  const emphasis = byte4 & 0x03;
  const channelMode = (byte4 >> 6) & 0x03;

  if (
    !hasSyncWord ||
    versionBits !== 0b11 ||
    layerBits !== 0b01 ||
    bitrateIndex === 0 ||
    bitrateIndex === 0x0f ||
    sampleRateIndex === 0x03 ||
    emphasis === 0b10
  ) {
    return undefined;
  }

  const bitrateKbps = MPEG_1_LAYER_3_BITRATES_KBPS[bitrateIndex]!;
  const sampleRateHz = MPEG_1_SAMPLE_RATES_HZ[sampleRateIndex]!;
  const frameLength = Math.floor((144_000 * bitrateKbps) / sampleRateHz) + padding;

  return { frameLength, hasCrc, isMono: channelMode === 0b11 };
}

function containsVbrMetadata(buffer: Uint8Array, offset: number, header: FrameHeader): boolean {
  const crcLength = header.hasCrc ? 2 : 0;
  const sideInformationLength = header.isMono ? 17 : 32;
  const xingOffset = offset + 4 + crcLength + sideInformationLength;
  const vbriOffset = offset + 4 + 32;

  return (
    hasAsciiMarker(buffer, xingOffset, 'Xing') ||
    hasAsciiMarker(buffer, xingOffset, 'Info') ||
    hasAsciiMarker(buffer, vbriOffset, 'VBRI')
  );
}

function hasAsciiMarker(buffer: Uint8Array, offset: number, marker: string): boolean {
  if (buffer.length - offset < marker.length) {
    return false;
  }

  return marker
    .split('')
    .every((character, index) => buffer[offset + index] === character.charCodeAt(0));
}
