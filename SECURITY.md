# Security policy

DroidDock controls an Android phone through an authorized ADB connection. It is intended for a trusted Windows PC and a local browser, not public or multi-user hosting.

## Report a vulnerability privately

Use the repository's [private vulnerability reporting form](https://github.com/hooware-ai/droiddock/security/advisories/new). Describe the affected revision, the impact, a minimal reproduction using synthetic data, and any proposed fix. Do not submit device identities, credentials, pairing codes, personal identifiers, private phone screenshots, or unredacted logs.

Do not open a public issue or pull request containing exploit details for an unpatched vulnerability. If the private form is unavailable, use a public issue only to say **"Private security reporting is unavailable"**, without vulnerability details, and wait for a private channel. Private vulnerability reporting must be enabled in repository settings at publication.

The project is early-stage. Security fixes target the current default branch; there is no published long-term support or backport policy and no guaranteed response time. Coordinated disclosure is encouraged so a fix can be prepared before technical details are made public.

## Trust boundary

- The HTTP service binds to `127.0.0.1`. Host/Origin checks, a custom header for control POSTs, and exact WebSocket Origin checks restrict ordinary cross-origin browser access.
- Only allowlisted assets are served. The browser sends structured phone controls; there is no general-purpose shell endpoint.
- The configured permanent phone identity is checked before control. Session resources and browser ownership are scoped to prevent one stale view from controlling its replacement.
- The bundled scrcpy server is pinned and checked against its recorded SHA-256. This detects changes relative to the checked-in pin; it does not independently audit the upstream binary or the repository itself.

These are defense measures, not an authentication system for local programs. Software running on the computer can imitate request headers. A compromised local process, browser extension, developer tool, authorized browser session, or user account can bypass the intended interaction boundary. ADB authorization itself grants powerful access to the phone.

Do not bind the service to a network interface, expose it through a public tunnel/proxy, or assume it is safe for untrusted shared-host use. Disconnect when finished and revoke debugging authorization on computers you no longer trust.

## Data handling

The app relays phone video and input locally and does not intentionally record their payloads. Explicit browser paste transfers plain text to the phone clipboard; automatic clipboard synchronization is disabled. Android apps and any other software inspecting the screen or clipboard have their own behavior and policies.

Phone PIN entry holds digits only temporarily in the masked field and relay memory, sends standard digit key events, and does not intentionally log or persist them. It blocks clipboard actions on that field. Clearing the field is not guaranteed memory erasure; browser autofill, extensions, developer tools, or other local software remain outside this protection. It does not detect the target prompt or prove authentication succeeded.

An optional AI/browser integration may capture phone content for processing outside DroidDock. Review that integration's policies and the visible screen before use. Local configuration, environment variables, process arguments, browser diagnostics, and launcher logs can reveal device or machine information; review and redact before sharing. Do not treat ignored files as encrypted or protected from other local software.

## Changes requiring particular care

Request validation, origin handling, control serialization, device identity, vendor updates, cleanup, and takeover logic require meaningful regression tests and maintainer review. Do not run vulnerability probes against another person's phone or expose a live phone to demonstrate a report.
