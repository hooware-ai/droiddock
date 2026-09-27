# Optional Codex integration

DroidDock works in a normal browser. A local Codex task on the **same Windows PC** can also show that page in a browser panel, keeping your phone beside the conversation. You need supported browser/panel tools in that task. Cloud tasks and tasks running on another computer cannot reach this PC's loopback service.

## Open the phone in a task

First complete [setup](SETUP.md). Give the local agent the DroidDock checkout location and ask it to open your phone. From the checkout it can run:

```powershell
pwsh -NoProfile -File scripts/Invoke-DroidDock.ps1 -Action open
```

The helper starts or reuses the matching local service and returns JSON containing its URL. **The helper does not itself open a Codex panel or click Connect.** The agent then uses the supported panel tool available to it, for example:

```json
{
  "placement": "right",
  "target": { "type": "browser", "url": "http://127.0.0.1:3210/" }
}
```

Use the URL returned by the helper, which may use a different port. With supported browser controls, select **Connect** and inspect actual rendered phone video. If panel inspection is unavailable, report that remaining step instead of claiming a working view. Do not use undocumented Codex IPC, app databases, or panel-resize tricks.

Selecting Connect in another view transfers control there. The previous view shows **Phone opened elsewhere** and becomes inactive. Inactive tabs do not reconnect automatically, and closing an old tab cannot disconnect its replacement. Handoff starts a fresh stream, so a brief pause is expected.

## Status and disconnect

```powershell
pwsh -NoProfile -File scripts/Invoke-DroidDock.ps1 -Action status
pwsh -NoProfile -File scripts/Invoke-DroidDock.ps1 -Action disconnect
```

Status does not start a stopped service or open a phone stream. If the running service was started from a different build of this checkout, `open` refuses to reuse it, while `status` and `disconnect` report `restartNeeded: true`; follow [update an installation](SETUP.md#update-an-installation). Disconnect ends the current phone session while leaving the service available. Helpers verify installation and configuration before acting and do not expose arbitrary Android or shell commands.

## Integrating with an agent

This repository supplies [agent instructions](../AGENTS.md) and lifecycle helpers, not a preinstalled Codex plugin. Installing DroidDock does not automatically add a skill or command to every task. You can call the documented helpers directly, or build a local integration using your Codex version's supported extension mechanisms.

Keep device configuration in the ignored `config.local.json`; do not copy identities or credentials into a plugin. Expose only the three lifecycle actions, respect the requested phone and task, and distinguish service readiness from browser video verification. Opening the phone is not permission to perform unrelated actions within its apps.

Phone screens may contain private content. If an agent captures screenshots or interprets the browser view, that content can be processed under the agent provider's policies. Choose what is on screen before inviting inspection; do not attach private phone screenshots to public issues.
