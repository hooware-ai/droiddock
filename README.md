# DroidDock by Hooware

**Your Android phone, docked in a browser.**

DroidDock brings live Android video and familiar phone controls to a local browser tab. Use it beside your work, or open it inside a local Codex task. The phone encodes H.264 with the unmodified **scrcpy 4.1 server**; DroidDock relays it to the browser's WebCodecs decoder without desktop capture or video re-encoding.

An open-source tool from [Hooware AI](https://github.com/hooware-ai). Early-stage software: supported setup is Windows, and live phone compatibility needs testing on your device. See the [compatibility notes](docs/COMPATIBILITY.md) for what CI covers and how to report a sanitized live result.

## Get started on Windows

You need a Windows PC, an Android phone you can authorize for debugging, Git to clone the repository, and a Chromium browser with WebCodecs support. Codex is optional. Wireless debugging requires Android 11 or newer; USB is the simplest first connection.

```powershell
git clone https://github.com/hooware-ai/droiddock.git
cd droiddock
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Install-DroidDock.ps1
```

The installer reuses compatible tools or installs Node.js 24+, PowerShell 7, and Android platform tools through WinGet. It installs locked dependencies, builds and checks the project, configures the intended phone, and starts the local service. Package installation can require platform approval and accepts the selected packages' agreements. Review the [setup guide](docs/SETUP.md) for dependency options and recovery.

Enable USB debugging, connect a data cable, and authorize the PC on the phone when prompted. If setup reports `needs_action`, complete that action and rerun it. Open the returned URL (normally **http://127.0.0.1:3210/**) in your browser and click **Connect**. The page reports which connection step is in progress. A successful setup result alone does not confirm that video rendered. Phone controls stay unavailable until a live frame appears.

To reopen an installed copy:

```powershell
pwsh -NoProfile -File scripts/Start-DroidDock.ps1 -OpenBrowser
```

For an agent-assisted setup, give a local agent with repository access this request:

```text
Set this up — https://github.com/hooware-ai/droiddock
```

[AGENTS.md](AGENTS.md) supplies the procedure. For an embedded phone view, see [optional Codex integration](docs/CODEX.md).

## What you can do

- Tap, drag, long-press, and scroll directly on the phone video.
- Use Back, Home, Recents, volume, and power controls in the side rail.
- Select **Enter fullscreen** to enlarge the phone and those controls together when the browser Fullscreen API is available. **Exit fullscreen** or Escape returns to the ordinary view. Embedded browsers may decline the request; the windowed dock stays usable.
- Open **Help** on the side rail for in-app notes on keyboard, pointer, paste, and fallback text. Help stays available while disconnected and does not send phone input. Keyboard users can open or close it and return focus to that control.
- Focus the screen for keyboard input, including Backspace, Enter, and arrows. Tab navigation and browser shortcuts remain in the browser. Press **Escape** to close Help, then the details panel; with those panels closed and the screen focused, Escape sends Back to the phone. Escape that exits fullscreen does not send Back.
- Press **Ctrl+V** over the focused phone screen to paste plain text. Unicode, emoji, and multiline text are supported when the Android app accepts them, up to 64 KiB of UTF-8 text. Paste changes the phone clipboard; images and files are not supported.
- Open the three-dot panel for device details and fallback text input. That input uses scrcpy text injection, supports ASCII and some accented letters, and is limited to 300 UTF-8 bytes per send. A live `N / 300 bytes` counter uses the same UTF-8 check as Send; over-limit text stays in the field so it can be shortened. The same panel can show optional local stream statistics (media bytes received, decoded frames drawn, and decode queue length) to help tell packet arrival from decode/render activity. Those numbers stay in the tab, are not sent anywhere, and are not end-to-end latency. A still phone screen may produce few frames; that is not a failure.
- Use **Phone PIN entry** in the three-dot panel for a masked, manually sent numeric PIN (1 to 64 digits). Open the phone prompt first; **Send digits** uses Android digit keys, while **Backspace on phone** and **Enter on phone** are separate actions. Some phones auto-submit the last digit. The picture may stay black on protected screens, and some prompts reject remote input. Use the physical phone when needed. No automatic retries, clipboard transfer, or saved PIN; the field clears after sending, panel closure, window focus loss, or connection loss. This does not provide remote biometrics or Windows Hello authentication.
- Click **Connect** in another DroidDock tab to move control there. The previous tab shows **Phone opened elsewhere** and becomes inactive. Handoff briefly reconnects the stream.
- Disconnect or close the controlling tab to release the phone session. The local service remains available for reopening.

Rotation resets the decoder for the new video dimensions. After a Wi-Fi interruption, restore connectivity and reconnect. Current stream settings are a maximum dimension of 1280 pixels, up to 60 fps, and 6 Mbps H.264; these are encoder settings, not performance guarantees.

Audio, recording, file transfer, multitouch, and automatic clipboard synchronization are **not implemented**. See the [roadmap](docs/ROADMAP.md) for proposed work.

## Local by design

DroidDock binds to `127.0.0.1` and serves a small, allowlisted browser interface. It checks HTTP Host/Origin, requires a custom header for control POSTs, and checks the exact local Origin for WebSockets. Browser control belongs to one active socket; late commands from a displaced tab cannot control its replacement. The browser API accepts structured controls, not arbitrary shell commands.

These checks do not authenticate other software on your PC. Use a trusted computer and browser; do not expose the service through port forwarding or a public proxy. Phone video and input are relayed locally, but an AI/browser tool you choose to use may capture phone content under that tool's own policies. The app does not intentionally record video or input payloads. Local diagnostic output can contain sensitive context and must be reviewed before sharing.

Each phone session owns its temporary device server, random scrcpy socket, and ADB forward. Cleanup targets those resources without restarting the shared ADB server. See [security](SECURITY.md) for the trust boundary and private reporting.

## Develop and contribute

Node.js **24 or newer** is required. A phone is not needed for the offline suite:

```powershell
npm ci --ignore-scripts
npm run verify
```

`npm test` uses built output, so build first. The suite covers protocol framing, structured controls, HTTP/WebSocket boundaries, ownership handoff, setup, diagnostics, lifecycle helpers, and keyboard/focus accessibility of the browser chrome. Linux and Windows CI run offline checks; they do not establish Linux host support or live Android compatibility. Windows phone/video checks are separate and require an authorized device. The [compatibility notes](docs/COMPATIBILITY.md) record that coverage.

Start with [CONTRIBUTING.md](CONTRIBUTING.md), the [architecture](docs/ARCHITECTURE.md), and the [starter tasks](docs/ROADMAP.md#starter-tasks). AI-assisted contributions are welcome. Contributors remain responsible for accuracy, provenance, privacy, and tests; maintainers review changes before merge.

## Documentation and support

| Need | Guide |
| --- | --- |
| Install, authorize a phone, recover, or remove | [Setup](docs/SETUP.md) |
| See tested Android and browser coverage | [Compatibility](docs/COMPATIBILITY.md) |
| Open the phone in a local Codex task | [Codex integration](docs/CODEX.md) |
| Understand the bridge and upgrade scrcpy | [Architecture](docs/ARCHITECTURE.md) |
| Report a bug or ask for help | [Support](SUPPORT.md) |
| Report a vulnerability privately | [Security](SECURITY.md) |
| See changes and proposed work | [Changelog](CHANGELOG.md) · [Roadmap](docs/ROADMAP.md) |

## License and upstream

Original DroidDock code is [MIT licensed](LICENSE). The pinned, unmodified scrcpy server retains its Apache-2.0 license; dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). DroidDock is an independent project and is not affiliated with or endorsed by Genymobile or OpenAI.

Built on [scrcpy](https://github.com/Genymobile/scrcpy). Protocol references: [scrcpy 4.1 developer documentation](https://github.com/Genymobile/scrcpy/blob/v4.1/doc/develop.md) and [control message reader](https://github.com/Genymobile/scrcpy/blob/v4.1/server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java).
