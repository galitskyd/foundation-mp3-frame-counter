import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { countMpeg1Layer3Frames } from '../src/mp3/frame-counter.js';
import { makeId3v2Tag, makeMpeg1Layer3Frame, makeXingMetadataFrame } from './fixtures.js';

function chunksAtEveryOffset(buffer: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, offset + chunkSize));
  }
  return chunks;
}

describe('countMpeg1Layer3Frames', () => {
  it('counts constant-bitrate frames split across small stream chunks', async () => {
    const file = Buffer.concat(Array.from({ length: 5 }, () => makeMpeg1Layer3Frame()));

    await expect(
      countMpeg1Layer3Frames(Readable.from(chunksAtEveryOffset(file, 17))),
    ).resolves.toBe(5);
  });

  it('counts variable-bitrate and padded frames', async () => {
    const file = Buffer.concat([
      makeMpeg1Layer3Frame({ bitrateIndex: 5 }),
      makeMpeg1Layer3Frame({ bitrateIndex: 9, padding: 1 }),
      makeMpeg1Layer3Frame({ bitrateIndex: 14, sampleRateIndex: 2 }),
    ]);

    await expect(countMpeg1Layer3Frames(Readable.from([file]))).resolves.toBe(3);
  });

  it('supports every MPEG-1 Layer III bitrate and sample-rate combination', async () => {
    const frames = [];
    for (let bitrateIndex = 1; bitrateIndex <= 14; bitrateIndex += 1) {
      for (let sampleRateIndex = 0; sampleRateIndex <= 2; sampleRateIndex += 1) {
        frames.push(makeMpeg1Layer3Frame({ bitrateIndex, sampleRateIndex, padding: 1 }));
      }
    }

    await expect(countMpeg1Layer3Frames(Readable.from([Buffer.concat(frames)]))).resolves.toBe(42);
  });

  it('does not count a Xing VBR metadata frame as decoded audio', async () => {
    const file = Buffer.concat([
      makeXingMetadataFrame(),
      makeMpeg1Layer3Frame(),
      makeMpeg1Layer3Frame({ bitrateIndex: 10 }),
    ]);

    await expect(countMpeg1Layer3Frames(Readable.from([file]))).resolves.toBe(2);
  });

  it('skips a large ID3v2 tag without requiring it in one chunk', async () => {
    const file = Buffer.concat([
      makeId3v2Tag(20_000),
      makeMpeg1Layer3Frame(),
      makeMpeg1Layer3Frame(),
    ]);

    await expect(
      countMpeg1Layer3Frames(Readable.from(chunksAtEveryOffset(file, 101))),
    ).resolves.toBe(2);
  });

  it('ignores junk before the first confirmed frame sequence and trailing ID3v1 metadata', async () => {
    const id3v1 = Buffer.alloc(128, 0x20);
    id3v1.write('TAG', 0, 'ascii');
    const file = Buffer.concat([
      Buffer.from([0x00, 0xff, 0xfb, 0x90, 0x00, 0x01]),
      makeMpeg1Layer3Frame(),
      makeMpeg1Layer3Frame(),
      id3v1,
    ]);

    await expect(countMpeg1Layer3Frames(Readable.from([file]))).resolves.toBe(2);
  });

  it('rejects a file without MPEG-1 Layer III frames', async () => {
    const mpeg2Layer3Header = Buffer.from([0xff, 0xf3, 0x90, 0x00]);

    await expect(countMpeg1Layer3Frames(Readable.from([mpeg2Layer3Header]))).rejects.toMatchObject({
      code: 'NO_AUDIO_FRAMES',
    });
  });

  it('rejects a truncated frame after a valid frame sequence', async () => {
    const first = makeMpeg1Layer3Frame();
    const second = makeMpeg1Layer3Frame();
    const third = makeMpeg1Layer3Frame();
    const file = Buffer.concat([first, second, third.subarray(0, 100)]);

    await expect(countMpeg1Layer3Frames(Readable.from([file]))).rejects.toMatchObject({
      code: 'TRUNCATED_AUDIO_FRAME',
    });
  });
});
