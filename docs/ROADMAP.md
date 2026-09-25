# Roadmap

DroidDock's next steps prioritize dependable local phone access, clear setup, and contributions that are easy to verify. These are proposals, not release dates or commitments. Discuss substantial work in an issue before implementing it.

## Near-term priorities

| Area | Useful next outcome | Evidence needed |
| --- | --- | --- |
| Compatibility | A documented Windows/browser/Android test matrix. | Volunteer test results added to [COMPATIBILITY.md](COMPATIBILITY.md) with versions, connection type, actual rendered video/control checks, and no device identities. |
| Lifecycle reliability | Better coverage of connection loss, startup cancellation, and failed cleanup. | Regression tests that demonstrate recovery without touching unrelated ADB resources. |
| Browser usability | Accessible controls, clearer keyboard focus, and actionable decoder/connection errors. | Keyboard-only review, accessibility checks, and synthetic-screen examples. |
| Setup and support | Clear recovery for common Windows toolchain, USB, and wireless-debugging failures. | Reproducible sanitized cases and tested instructions. |
| Optional agent integration | A reusable, documented extension package using supported Codex surfaces. | Clean installation and removal checks, privacy review, and explicit rendering verification. |

## Starter tasks

These are scoped ideas suitable for a first contribution; check for an existing issue or claim before beginning.

- **Document one recovery case.** Reproduce a Windows setup problem, explain the exact symptom and safe fix, and remove identifying information from the report.
- **Add a protocol regression case.** Find an untested malformed or fragmented packet/control boundary in `protocol.ts` and demonstrate the expected rejection or parse behavior.
- **Audit keyboard access.** Check focus order, visible focus, Escape behavior, and accessible labels in the browser UI; propose a small verified fix.
- **Clarify an error message.** Reproduce a confusing failure, improve the user-facing explanation without exposing raw device/process output, and cover the behavior where practical.
- **Contribute a compatibility result.** Follow the live checklist in `CONTRIBUTING.md` and the table in [COMPATIBILITY.md](COMPATIBILITY.md). Report platform versions and pass/fail results with synthetic content. Do not include serials or private screenshots.

## Exploratory work

Cross-platform live support would require platform-specific discovery, launch, cleanup, and real-device validation. Linux offline CI alone is insufficient. A packaged installer and configurable video settings may be useful once the current setup and compatibility behavior are well characterized.

Audio, recording, general file transfer, multitouch, and automatic clipboard synchronization are not implemented or scheduled. Explicit rich-content paste is available for compatible focused apps through the optional Android helper; it does not cover all file attachment fields. Each broader feature would need its own design and privacy review. Public/network hosting is outside the current local-only design.

## How work reaches users

Propose a concrete problem and acceptance criteria, implement a focused change, provide meaningful tests and any required live evidence, and submit it for maintainer review. AI assistance is welcome; review and accountability remain with contributors and maintainers. No bot or agent is promised authority to approve or merge its own work.
