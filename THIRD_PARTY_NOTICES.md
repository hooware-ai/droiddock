# Third-party components

DroidDock includes the unmodified scrcpy 4.1 device server from
[Genymobile/scrcpy](https://github.com/Genymobile/scrcpy/releases/tag/v4.1).
Its Apache License 2.0 is preserved at
`droiddock/vendor/scrcpy-4.1/LICENSE`; provenance and SHA-256 are recorded in
`droiddock/vendor/scrcpy-4.1/upstream.json`. No upstream source patches are applied.

Original DroidDock code is provided under the [MIT License](LICENSE).
Third-party components retain their own licenses and attribution. No claim is
made that Hooware authored scrcpy or its dependencies.

| Component | Role | License |
| --- | --- | --- |
| scrcpy 4.1 server | Android video and control server | Apache-2.0 |
| ws | Local WebSocket transport | MIT |
| TypeScript | Development compiler | Apache-2.0 |
| @types/node, @types/ws, undici-types | Development type definitions | MIT |
| Gradle 9.6.1 wrapper | Optional Android helper build launcher | Apache-2.0 |
| Android Gradle Plugin 9.3.2 | Optional Android helper build plugin | Apache-2.0 |

The exact npm versions, registry URLs, and integrity hashes are in
`package-lock.json`. npm installs retain the dependencies' license files.
Gitleaks is a development-only secret scanner downloaded by the verification
helper from its official release with a pinned SHA-256; it is not shipped in
the source archive. Gitleaks uses the MIT License.

The optional Android helper includes the standard Gradle wrapper scripts and JAR.
Its JAR SHA-256 is pinned in `scripts/check-public.mjs`; its Gradle distribution
URL and SHA-256 are pinned in `android/paste-helper/gradle/wrapper/gradle-wrapper.properties`.
The Android Gradle Plugin is fetched only when building the helper. Gradle and
the plugin are independently maintained and licensed under Apache-2.0.

Android platform tools, Node.js, PowerShell, browsers, and Codex are separately
installed products subject to their own terms. Hooware is not affiliated with
or endorsed by their vendors or the scrcpy maintainers.
