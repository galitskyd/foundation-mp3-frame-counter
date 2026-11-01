const BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES_HZ = [44_100, 48_000, 32_000];

type FrameOptions = {
  bitrateIndex?: number;
  sampleRateIndex?: number;
  padding?: 0 | 1;
  fill?: number;
};

export function makeMpeg1Layer3Frame(options: FrameOptions = {}): Buffer {
  const bitrateIndex = options.bitrateIndex ?? 9;
  const sampleRateIndex = options.sampleRateIndex ?? 0;
  const padding = options.padding ?? 0;
  const bitrateKbps = BITRATES_KBPS[bitrateIndex]!;
  const sampleRateHz = SAMPLE_RATES_HZ[sampleRateIndex]!;
  const frameLength = Math.floor((144_000 * bitrateKbps) / sampleRateHz) + padding;
  const frame = Buffer.alloc(frameLength, options.fill ?? 0);

  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding << 1);
  frame[3] = 0;
  return frame;
}

export function makeXingMetadataFrame(): Buffer {
  const frame = makeMpeg1Layer3Frame();
  // MPEG-1 stereo side information occupies 32 bytes after the four-byte header.
  frame.write('Xing', 36, 'ascii');
  return frame;
}

export function makeId3v2Tag(payloadLength: number): Buffer {
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header[3] = 4;
  header[4] = 0;
  header[5] = 0;
  header[6] = (payloadLength >> 21) & 0x7f;
  header[7] = (payloadLength >> 14) & 0x7f;
  header[8] = (payloadLength >> 7) & 0x7f;
  header[9] = payloadLength & 0x7f;
  return Buffer.concat([header, Buffer.alloc(payloadLength, 0x5a)]);
}

export function multipartBody(file: Buffer, boundary: string, filename = 'sample.mp3'): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: audio/mpeg\r\n\r\n',
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}
