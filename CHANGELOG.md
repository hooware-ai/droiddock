# Changelog

Changes are recorded here when they affect users or contributors. This document is not evidence of a published release.

## Unreleased

- Probe WebCodecs `VideoDecoder.isConfigSupported` for the phone's H.264 configuration before configuring the decoder, and show a concise local error when that configuration is unsupported or the support check fails.
- Keyboard and focus accessibility on the browser chrome: a rail focus outline with at least 3:1 contrast on its light backgrounds and a canvas outline tested against black, a connection status live region outside the details panel, Escape that closes that panel before sending Android Back, and offline tests of names, tab order, and keyboard behavior on a synthetic screen.

Initial public source distribution of DroidDock by Hooware:

- Local browser video and structured Android controls through the pinned, unmodified scrcpy 4.1 server.
- H.264 decoding through WebCodecs, keyboard input, mouse/touch controls, and explicit plain-text clipboard paste.
- Single-controller browser handoff with stale-view protection and scoped session cleanup.
- Windows setup, phone discovery, launch, lifecycle, and diagnostic helpers.
- Optional local Codex browser-panel workflow.
- Offline tests for protocol handling, HTTP/WebSocket boundaries, ownership, setup, diagnostics, and lifecycle operations.
- Public setup, contributor, support, security, architecture, and roadmap documentation.
- Bounded subprocess execution, redacted command errors, and retryable cleanup that verifies the intended device.
- Publication checks for private data, credentials, source provenance, and release archive contents.
- Reproducible source archives with checksums, dependency updates, and pinned CI and security workflows.
- Compatibility notes that record CI coverage, intended setup requirements, and the empty live Android/browser matrix, plus how to report a sanitized result.

No live-phone compatibility matrix or stable-release support promise is established by this initial source distribution.
