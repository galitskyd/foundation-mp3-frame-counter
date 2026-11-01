# Interview walkthrough

## Two-minute overview

I built a Fastify/TypeScript endpoint at `POST /file-upload`. It streams the multipart file into a
parser I wrote from the MPEG-1 Layer III header rules and returns `{ "frameCount": number }`. I did
not use an MP3 parsing dependency. The supplied sample produces 6,089 frames, which I independently
checked with `ffprobe`.

The important design choice is streaming. A buffer-all implementation is simpler, but its memory
cost grows with every concurrent upload. This parser only retains enough bytes to finish the
current frame or make the initial synchronization decision.

## Algorithm to explain at the whiteboard

An MPEG frame begins with an 11-bit sync word. The next header fields identify the MPEG version,
layer, bitrate index, sample-rate index, and padding. For MPEG-1 Layer III:

```text
frame length = floor(144000 × bitrateKbps / sampleRateHz) + padding
```

After validating the reserved values, I jump by the calculated frame length instead of scanning
every payload byte. I recalculate for each frame, so variable-bitrate files are naturally handled.
I skip a leading ID3v2 tag from its synchsafe length, recognize an initial Xing/Info or VBRI
metadata frame without counting it as decoded audio, and stop when contiguous audio ends, allowing
trailing metadata.

## Decisions and trade-offs

- **Fastify + `@fastify/multipart`:** small HTTP layer, native stream handoff, good TypeScript
  support. The MP3 logic stays framework-independent.
- **Confirm the first frame boundary:** sync bits can appear by chance in metadata or junk. Requiring
  another valid header exactly where the calculated frame ends makes the initial lock defensible.
- **Trust calculated boundaries after lock:** payload can contain sync-like bytes, so byte-scanning
  inside confirmed frames would create false positives.
- **Explicit scope:** MPEG-2/2.5, Layers I/II, and free-format bitrate are rejected. That matches the
  brief and avoids pretending unsupported formats are counted correctly.
- **Byte validation, not extension validation:** clients and MIME types are inconsistent. The file
  contents decide whether it is supported.
- **Decoded-audio count:** a Xing/Info frame is a container for VBR metadata rather than an audio
  frame. The sample has 6,090 MPEG headers but declares and decodes to 6,089 audio frames, so the
  metadata frame is deliberately excluded.
- **100 MiB default cap:** streaming protects steady-state memory, while the cap protects connection
  time and total work. It is configurable.

## Testing story

The tests synthesize frames from the same public header rules rather than committing the supplied
audio. They cover chunk boundaries, VBR/padding, a large ID3v2 tag, leading junk, trailing ID3v1,
unsupported audio, truncation, the JSON contract, missing files, invalid content, content type, and
the size limit. `npm run check` also runs formatting, linting, and a strict TypeScript build.

For acceptance, I ran the actual supplied sample through the endpoint and compared 6,089 with
`ffprobe -count_frames`. The external tool is only an oracle for verification; it is not part of the
application.

## What I would do next

1. Add fuzzing/property tests and a curated corpus covering CRC, mono/stereo modes, all legal
   bitrates/sample rates, damaged streams, and multiple encoders.
2. Add request timeouts, concurrency controls, authentication, tenant rate limits, and telemetry.
3. Containerize and deploy multiple stateless instances behind a load balancer; uploads require no
   shared state.
4. If product scope expands, implement version/layer-specific tables and frame formulas as explicit
   strategies, keeping the current MPEG-1 behavior unchanged.

## Likely pushback

**Why not use a package?** The exercise prohibits an MP3 frame parser, and implementing the narrow
format directly makes the correctness rules visible. I still use maintained packages for HTTP and
multipart concerns that are outside the parsing requirement.

**Why not read the whole file?** It would pass the sample but scale poorly under large or concurrent
uploads. Streaming is not much more code here and makes resource behavior predictable.

**Can one valid-looking header fool it?** For normal files, the first candidate must predict the next
valid header exactly. A single-frame-at-EOF exception supports that legitimate edge case. In a
hostile-content service, I might require multiple confirmations or use a confidence threshold.

**What happens if the client disconnects?** The multipart stream terminates; the async iteration
stops and no global state remains. In production I would record cancellation metrics and enforce an
application deadline.
