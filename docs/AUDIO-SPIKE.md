# Audio playback spike

This is the design note for [issue #63](https://github.com/hooware-ai/droiddock/issues/63): playing the docked phone's audio through Windows. It is research only. **Production audio behavior is unchanged:** the session still starts the pinned scrcpy 4.1 server with `audio=false`. The proof of feasibility in `scripts/audio-spike.mjs` uses synthetic audio only and never contacts a phone or ADB.

## Recommendation

Play audio **in the browser**: forward the scrcpy 4.1 Opus stream over the existing loopback bridge, decode it with WebCodecs `AudioDecoder`, and schedule it through `AudioContext`. Make it an opt-in setting that starts only from the Connect gesture, with a mute control.

This fits the existing architecture: one browser view owns the session, and Windows plays the sound through the browser tab's normal output device and volume.

The synthetic measurements below suggest that decoding and scheduling have low host cost. They are single-run observations, not a playback guarantee. The main open risks include browser scheduling under stalls and, on the device side, capture support, phone-speaker restoration, app opt-outs, and end-to-end latency.

## What the pinned server provides

These facts come from the scrcpy 4.1 `develop.md`, `audio.md`, `Streamer`, `AudioCodec`, and `DesktopConnection` sources.

- **Sockets:** enabling audio (`audio=true`) opens up to three sockets, **in order: video, audio, control**. DroidDock currently opens video, then control, so audio support must open the audio socket between them. Only the first socket receives the dummy byte.
- **Stream header:** the audio socket starts with a `u32` codec id: `opus` `0x6F707573`, `aac` `0x00616163`, `flac` `0x666C6163`, or `raw` `0x00726177`. Special value `0` means capture is unavailable and video continues. Value `1` means a fatal audio configuration error: scrcpy stops the whole session and closes video, audio, and control sockets. The bridge must clean up and reconnect the entire session; it cannot simply turn audio off.
- **Packets:** each has a 12-byte header, like video, with a config flag, a key-frame flag, a 61-bit PTS in microseconds, and a `u32` size. Audio has **no session packets**. Media PTS comes from Android's monotonic clock, so it is not relative to the first packet or the browser page. The server rewrites the Opus config packet into a plain 19-byte `OpusHead`, which is exactly what WebCodecs `AudioDecoder` accepts as its `description`.
- **Defaults:** Opus at 128 kbit/s and 48 kHz stereo. `raw` is 16-bit PCM at about 1.5 Mbit/s.
- **Sources:**
  - `audio_source=output` (the default) captures the whole output through `REMOTE_SUBMIX` and **disables playback on the phone**.
  - `audio_source=playback` with `audio_dup=true` keeps sound playing on the phone. It requires Android 13+, and apps can opt out of capture.
  - Microphone and voice-call sources exist but are out of scope.
- **Android versions:** Android 12+ works as is. Android 11 needs the phone unlocked when the stream starts. Android 10 and earlier cannot capture audio, and the server sends codec id `0`.

## Options compared

| Option | Transport | Host cost | Fit | Verdict |
| --- | --- | --- | --- | --- |
| Browser: Opus + `AudioDecoder` + `AudioContext` | ~16.7 KB/s (measured, including headers) | Decode ~200× real time; 0.2 ms main-thread work per packet | Uses the tab's output device and volume; one owner per view | **Recommended** |
| Browser: `raw` PCM + `AudioWorklet` | ~192 KB/s | No decoder | Same fit, but 11× the bandwidth over wireless ADB | Fallback if a phone lacks an Opus encoder |
| Native Windows playback (a helper process or the scrcpy client) | Separate path | New binary to pin and ship | Bypasses browser ownership, handoff, and tab controls; needs its own lifecycle and cleanup | Rejected |

Which source to use is a product decision. `output` matches "docked" best: the whole phone output moves to the computer, and the phone stays silent until the session ends. `playback` with duplication keeps the phone audible, but it misses apps that opt out and needs Android 13+.

**Suggestion:** default to `output`, and add an explicit "also play on phone" option only after testing on real devices.

## Measured feasibility (synthetic)

Setup: Windows 11, the Chromium 152 browser pane of the Claude desktop app, `node scripts/audio-spike.mjs`.

- **Stream:** 10 s of synthetic stereo tone (440 Hz left, 660 Hz right), encoded with WebCodecs Opus at 128 kbit/s in 20 ms frames.
- **Framing:** byte for byte as the scrcpy 4.1 audio socket: codec id, `OpusHead` config packet, then media packets. The stream was fed to the incremental parser in random 1–4096-byte chunks.

| Offline decode | Result |
| --- | --- |
| Packets / stream rate | 501 packets, 16,719 bytes/s including headers |
| Parse time, whole stream | 1.3 ms |
| Decode time, 10 s of audio | 50 ms (≈200× real time) |
| Decoded duration | 10.014 s |
| Tone check (zero crossings) | 439.5 Hz / 659.5 Hz (source 440 / 660) |

The first runs did **not** wait for final playback or flush the decoder, so their zero-underrun counts cannot be used as completion evidence. The corrected probe uses a nonzero Android-like first PTS of 25,000,000,000 microseconds, maps packet timing relative to that first PTS, flushes the decoder, checks all 501 packets were decoded and scheduled, and waits for all 501 sources to end. It remains muted and synthetic. The `AudioContext` was created from a click and was running; context latency in the runs below was 10 ms base plus 40 ms output.

Corrected probe, isolated headless Edge 155 on Windows 11, one run per target:

| Target buffer | Main thread busy | Underruns | Scheduled lead p50 / p95 | Decoded / scheduled / ended |
| --- | --- | --- | --- | --- |
| 60 ms | 0% | 1 | 58.7 / 69.3 ms | 501 / 501 / 501 |
| 1000 ms | 0% | 1 | 1020 / 1030.7 ms | 501 / 501 / 501 |

**Interpretation:**
- Decode and output-handler cost were small in these isolated runs (offline decode 48–57 ms for ten seconds of tone; output handler p95 0.2 ms). Each corrected real-time run nevertheless counted one scheduler underrun, so zero-underrun playback has **not** been demonstrated. Test many runs, stalls, and live traffic before selecting a production buffer.
- Host-side latency is roughly scheduled lead + base + output, about 110–120 ms at the 60 ms target in these runs, plus unmeasured device capture and encode time. Audio may trail video, which is displayed as soon as it is decoded. Synchronization is not proposed for a first version.
- **Not measured:**
  - long stalls such as hidden-tab timer throttling or garbage-collection pauses above the lead;
  - Edge and Chrome as separate browsers;
  - audible output quality;
  - device capture latency, device CPU, and battery.

## Lifecycle and data flow

```
phone: AudioRecord -> MediaCodec (Opus) -> audio socket (codec id, config, packets)
bridge: ADB forward -> AudioStreamParser (bounded) -> current controller WebSocket (tagged audio frames)
browser: AudioDecoder -> AudioBuffer scheduling -> GainNode (mute/volume) -> Windows default output
```

- **Start:** only when the user has enabled audio. The Connect click creates or resumes the `AudioContext`, which satisfies autoplay rules. If the browser still blocks playback, show "Click to enable phone audio" and never retry automatically.
- **Timestamp mapping:** anchor the first media PTS to its browser arrival time, then schedule relative to `(packetPTS - firstPTS) / 1e6` with a target buffer. Do not compare absolute Android PTS to page elapsed time. If PTS jumps forward, preserve the gap or deliberately rebuffer instead of compressing time; if it jumps backward, reset the anchor and decoder after a discontinuity. Monitor lead over time and adjust the anchor gradually for clock drift, with a bounded buffer and a clear maximum latency. These policies need live measurements before production values are chosen.
- **Stop:** on disconnect, handoff, controller close, service shutdown, or scrcpy session loss, drop queued packets, close the decoder, and suspend the context. Packets from an old session generation are discarded, as for video.
- **Hidden tab:** keep playing, since audible tabs are generally exempt from heavy throttling, but this needs checking. Allow a larger target buffer if underruns appear.
- **Failure:** codec id `0`, a browser decoder error, or parser bounds turn audio off with a plain message while video and control remain usable. Codec id `1` is different: the scrcpy server stops, so close all three sockets, clear the session, and offer a fresh connection without automatic retries.
- **Phone speaker with `output`:** it should return when capture stops. Verify this live on disconnect, handoff, service shutdown, killed service, and lost connection before relying on it.

## Support matrix (expected, not yet verified live)

| Android | `output` | `playback` + duplication | Notes |
| --- | --- | --- | --- |
| 10 and earlier | Not available (codec id 0) | Not available | Video only |
| 11 | Needs the phone unlocked at start | Not available | Server shows a brief foreground popup |
| 12 | Supported | Not available | |
| 13+ | Supported; phone silent | Supported; apps can opt out | |

Browsers: WebCodecs Opus decoding was verified in Chromium 152. DroidDock already requires WebCodecs for video, so no new browser requirement is expected.

## Privacy and security

- Audio stays on the loopback bridge and goes only to the current controller's WebSocket.
- No recording, persistence, logging of audio bytes, telemetry, or public samples. Validation uses synthetic audio or explicitly consented playback.
- No system-wide output-device change; the browser tab's normal output is used.
- Bounded parsing (a 1 MiB packet cap in the spike) and backpressure. The spike parser copies incoming chunks incrementally into a buffer no larger than one validated packet plus its 12-byte header, even when a chunk contains many packets. Production should also cap total queued decoded frames and WebSocket bytes. Audio shares the video socket's congestion limit or has its own, so a slow tab cannot grow memory without bound.
- `output` capture includes every sound the phone plays, including notifications. The setting and Help text must say so.

## Remaining unknowns (live checks, **not run**)

No live phone test was run. It would capture and play the real audio of the only available phone, which is a personal device, and it requires explicit consent. These still need checking:

- capture on Android 12, 13, and 14+;
- whether the phone speaker returns after each stop path;
- app opt-outs with `playback`;
- end-to-end latency and audio-video offset;
- device CPU and battery impact;
- wireless ADB throughput with video and audio together;
- Edge and Chrome behavior when the tab is hidden.

## Proposed execution issues

These are proposed here for review. They will be opened as linked issues once maintainers agree the evidence supports this design.

1. **Session and protocol:** optional audio socket (open order video, audio, control), a production `AudioStreamParser` with bounds and both special codes, fatal whole-session cleanup for codec id `1`, tagged audio frames on the controller WebSocket, and backpressure. Tests: fragmentation, disable codes, fatal cleanup, bounds, stale generations.
2. **Browser playback and controls:** an opt-in setting, an `AudioContext` created from the Connect gesture, a mute control with `aria-pressed`, a blocked-autoplay message, and decoder errors that leave video working.
3. **Lifecycle and error handling:** stop and cleanup on every path, discarding stale packets after handoff or reconnect, hidden-tab behavior, and no automatic retries.
4. **Live compatibility:** the checks above on authorized test phones, recorded in [COMPATIBILITY.md](COMPATIBILITY.md), before the setting is documented as supported.

## Reproduce

```powershell
node scripts/audio-spike.mjs
```

Open the printed loopback URL in Edge or Chrome. The offline decode test runs automatically. **Run real-time playback test** needs a click and stays muted unless **Audible** is checked. Optional query parameters: `?target=<ms>` sets the playback buffer, and `?busy=<ms>` blocks the main thread for that many milliseconds every 16 ms. Results appear on the page and in `window.__audioSpike`. The parser has offline tests in `droiddock/tests/audio-spike.test.mjs`.
