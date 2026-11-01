import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { makeMpeg1Layer3Frame, multipartBody } from './fixtures.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('POST /file-upload', () => {
  it('returns the frame count as JSON', async () => {
    const app = await buildApp();
    apps.push(app);
    const boundary = 'test-boundary';
    const file = Buffer.concat([
      makeMpeg1Layer3Frame(),
      makeMpeg1Layer3Frame({ bitrateIndex: 10 }),
      makeMpeg1Layer3Frame({ padding: 1 }),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(file, boundary),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ frameCount: 3 });
  });

  it('rejects a missing file with a useful error', async () => {
    const app = await buildApp();
    apps.push(app);
    const boundary = 'empty-boundary';

    const response = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}--\r\n`),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'FILE_REQUIRED',
        message: 'Upload one MP3 file as multipart form data.',
      },
    });
  });

  it('rejects invalid audio content', async () => {
    const app = await buildApp();
    apps.push(app);
    const boundary = 'invalid-boundary';

    const response = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(Buffer.from('not an mp3'), boundary),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_MP3' } });
  });

  it('enforces the configured upload limit', async () => {
    const frame = makeMpeg1Layer3Frame();
    const app = await buildApp({ maxFileSizeBytes: frame.length - 1 });
    apps.push(app);
    const boundary = 'limit-boundary';

    const response = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(frame, boundary),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE' } });
  });

  it('requires multipart form data', async () => {
    const app = await buildApp();
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/file-upload',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
  });
});
