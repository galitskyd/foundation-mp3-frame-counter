# MPEG-1 Layer III frame counter

A small TypeScript API that accepts an MP3 upload and returns the number of MPEG-1 Audio
Layer III frames it contains. The parser is implemented in this repository; no MP3 parsing
package is used.

## Quick start

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

In another terminal:

```bash
curl -X POST http://localhost:3000/file-upload \
  -F "file=@/path/to/file.mp3"
```

Successful response:

```json
{
  "frameCount": 6089
}
```

The number above is the result for the sample supplied with the assessment; other files will
return their own count.

## Checks

```bash
npm run check
```

This runs formatting verification, linting, unit and endpoint tests, and a production TypeScript
build. The same command runs in GitHub Actions on pushes and pull requests. To run the compiled
service:

```bash
npm run build
npm start
```

Configuration:

| Variable              |     Default | Purpose                       |
| --------------------- | ----------: | ----------------------------- |
| `PORT`                |      `3000` | HTTP port                     |
| `HOST`                |   `0.0.0.0` | Bind address                  |
| `MAX_FILE_SIZE_BYTES` | `104857600` | Maximum upload size (100 MiB) |

## API

### `POST /file-upload`

Send one file in a `multipart/form-data` request. The field name is not significant.

- `200`: `{ "frameCount": number }`
- `400`: file missing, invalid MP3, unsupported MPEG format, or truncated frame
- `413`: configured file limit exceeded
- `415`: request is not multipart form data
- `500`: unexpected processing failure

Errors use a stable, human-readable JSON shape:

```json
{
  "error": {
    "code": "INVALID_MP3",
    "message": "No valid MPEG-1 Audio Layer III frames were found."
  }
}
```

## How frame counting works

Each MPEG audio frame starts with a four-byte header. The parser:

1. skips a leading ID3v2 tag using its synchsafe size field;
2. searches for a valid MPEG-1, Layer III header and confirms it using the next frame boundary;
3. reads the bitrate index, sample-rate index, and padding bit from the header;
4. calculates `floor(144000 × bitrateKbps / sampleRateHz) + padding` bytes;
5. excludes an initial Xing/Info or VBRI metadata frame from the decoded-audio count;
6. advances by that exact length and counts each audio frame; and
7. stops at trailing metadata such as ID3v1.

The upload is consumed as an async stream. Only a small incomplete remainder is carried between
chunks, so memory use is effectively constant with respect to file size. VBR files work because
the length is recalculated independently for every frame.

The first candidate is confirmed against the following header boundary. This avoids treating a
sync-like byte sequence in leading junk as audio. Once the contiguous audio sequence begins,
headers are expected exactly at the calculated boundaries.

## Scope and trade-offs

- The brief explicitly limits required support to MPEG Version 1 Audio Layer 3. MPEG-2/2.5 and
  Layers I/II are rejected rather than silently miscounted.
- Free-format frames (bitrate index `0`) are rejected because their frame length cannot be derived
  from one header without a more expensive synchronization strategy.
- CRC-protected frames are supported because the protection bit does not change total frame size.
- A leading Xing/Info or VBRI frame contains stream metadata rather than decoded audio. It is
  recognized from its format-defined location and excluded, matching the supplied file's declared
  and independently decoded count.
- A one-frame file is accepted when that frame ends at EOF. Normal multi-frame files require a
  confirmed first boundary, reducing false positives.
- The API does not trust the filename or MIME type; it validates the bytes.

## Production follow-ups

For a production service I would add authentication and per-tenant rate limits, request deadlines,
metrics (bytes, latency, rejection reasons), tracing, and structured audit-safe logs. I would also
run the process with CPU and memory limits, tune upload limits to the product's actual needs, and
add fuzz/property tests against a corpus of valid and damaged MP3 files. If other MPEG versions
became a product requirement, I would add separate version/layer tables behind the same validated
header model rather than weakening the MPEG-1 path.

## Repository map

```text
src/
  app.ts                 HTTP route and error mapping
  server.ts              process configuration and lifecycle
  mp3/frame-counter.ts   streaming MPEG frame parser
test/
  frame-counter.test.ts  parser behavior and boundary cases
  app.test.ts            endpoint contract and error responses
  fixtures.ts            synthetic frames built from the MPEG header rules
```

The employer-provided MP3 is intentionally ignored by Git. Place it under `samples/` if you want
to repeat the local acceptance test.
