import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runChecked } from "../process.js";
import { config } from "./config.js";
import { parseLockState, type LockState } from "./lock-state.js";
import { VideoParser, SCRCPY_VERSION, SERVER_SHA256, encodeControl, type VideoEvent } from "./protocol.js";

export const CONNECTION_PROGRESS = {
  findingPhone: "Finding the configured phone…",
  preparingConnection: "Preparing the phone connection…",
  openingStream: "Opening the video stream…",
} as const;

export type ConnectionProgressMessage = (typeof CONNECTION_PROGRESS)[keyof typeof CONNECTION_PROGRESS];

export class ScrcpySession {
  private transport = "";
  private port = 0;
  private forwardTransport = "";
  private forwardMayExist = false;
  private child?: ChildProcess;
  private video?: Socket;
  private control?: Socket;
  private closed = false;
  private remoteMayExist = false;
  private pastePending?: Promise<boolean>;
  private readonly pasteCleanup = new Map<string, { remote: boolean; privateFile: boolean }>();
  private readonly scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, "0");
  private readonly remote = `/data/local/tmp/droiddock-${this.scid}.jar`;
  private readonly adb = config.adb;
  private readonly serial = config.deviceSerial;
  constructor(
    private root: string,
    private onEvent: (event: VideoEvent) => void,
    private onFailure: (message: string) => void,
    private onProgress: (message: ConnectionProgressMessage) => void = () => {},
  ) {}
  private check(signal: AbortSignal) { signal.throwIfAborted(); if (this.closed) throw new Error("Session closed."); }
  private progress(message: ConnectionProgressMessage) { if (!this.closed) this.onProgress(message); }
  private command(args: string[], timeoutMs = 8000) { return runChecked(this.adb, ["-s", this.transport, ...args], { timeoutMs }); }
  private async findTransport(identityTimeout = 8000): Promise<string> {
    const found = await runChecked("pwsh", ["-NoProfile", "-File", join(this.root, "scripts/Find-DroidDockDevice.ps1"), "-DeviceSerial", this.serial, "-AdbPath", this.adb, "-WaitSeconds", "15"], { timeoutMs: 20000 });
    const transport = found.stdout.trim();
    if (!transport || /\s/.test(transport)) throw new Error("Phone discovery returned an invalid transport.");
    const identity = await runChecked(this.adb, ["-s", transport, "shell", "getprop", "ro.serialno"], { timeoutMs: identityTimeout });
    if (identity.stdout.trim() !== this.serial) throw new Error("The connected device is not the configured phone.");
    return transport;
  }
  private async cleanupTransport(): Promise<void> {
    try {
      const identity = await runChecked(this.adb, ["-s", this.transport, "shell", "getprop", "ro.serialno"], { timeoutMs: 3000 });
      if (identity.stdout.trim() === this.serial) return;
    } catch { /* Wireless endpoints can change while the permanent identity stays fixed. */ }
    this.transport = await this.findTransport(3000);
  }

  async start(signal: AbortSignal): Promise<void> {
    const vendor = join(this.root, "droiddock/vendor/scrcpy-4.1/scrcpy-server");
    const bytes = await readFile(vendor).catch(() => { throw new Error("The pinned scrcpy server could not be read. Restore the DroidDock vendor file."); });
    if (createHash("sha256").update(bytes).digest("hex") !== SERVER_SHA256) throw new Error("The pinned scrcpy server checksum does not match. Restore the DroidDock vendor file.");
    this.check(signal);
    const serial = this.serial;
    if (!serial || serial === "YOUR_DEVICE_SERIAL") throw new Error("Set deviceSerial in config.local.json before connecting. See README.md.");
    if (!/^[A-Za-z0-9]+$/.test(serial)) throw new Error("Invalid device serial.");
    this.progress(CONNECTION_PROGRESS.findingPhone);
    const transport = await this.findTransport();
    this.check(signal);
    this.transport = transport;
    this.progress(CONNECTION_PROGRESS.preparingConnection);
    // A failed push can still create a partial file, so cleanup owns it from here.
    this.remoteMayExist = true;
    await this.command(["push", vendor, this.remote]);
    this.check(signal);
    // Allocation may succeed before a timeout hides its returned port. The
    // captured transport and random socket still identify exactly our listener.
    this.forwardTransport = this.transport;
    this.forwardMayExist = true;
    const forwarded = await this.command(["forward", "tcp:0", `localabstract:scrcpy_${this.scid}`]);
    this.port = Number(forwarded.stdout.trim());
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error("ADB did not allocate a tunnel port.");
    this.check(signal);
    this.child = spawn(this.adb, ["-s", this.transport, "shell", `CLASSPATH=${this.remote}`, "app_process", "/", "com.genymobile.scrcpy.Server", SCRCPY_VERSION,
      `scid=${this.scid}`, "tunnel_forward=true", "audio=false", "control=true", "video_codec=h264", "max_size=1280", "max_fps=60", "video_bit_rate=6000000",
      "send_device_meta=false", "clipboard_autosync=false", "stay_awake=false", "cleanup=true", "log_level=warn"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    // Vendor output can contain private device details. Drain it without storing
    // it or copying it into browser status messages.
    this.child.stdout?.resume(); this.child.stderr?.resume();
    this.child.on("error", () => { if (!this.closed) this.onFailure("Could not start the scrcpy device server."); });
    this.child.on("exit", () => { if (!this.closed && !signal.aborted) this.onFailure("Phone connection ended. Check the phone connection and reconnect."); });
    this.check(signal);
    this.progress(CONNECTION_PROGRESS.openingStream);

    // ADB accepts TCP even before the device socket is listening. The dummy byte
    // confirms a real video connection before opening the second/control socket.
    for (let attempt = 0; attempt < 40; attempt++) {
      this.check(signal);
      try { this.video = await this.openVideo(signal); break; }
      catch { this.check(signal); await delay(150, undefined, { signal }); }
    }
    if (!this.video) throw new Error("The phone did not open its video stream. Check the phone connection and reconnect.");
    this.video.on("error", () => { if (!this.closed) this.onFailure("The phone video connection was lost."); });
    this.video.on("close", () => { if (!this.closed) this.onFailure("Phone disconnected. Check Wi-Fi and reconnect."); });
    this.control = createConnection({ host: "127.0.0.1", port: this.port });
    this.control.setNoDelay(true);
    this.control.on("error", () => { if (!this.closed) this.onFailure("The phone control connection was lost."); });
    this.control.on("close", () => { if (!this.closed) this.onFailure("The phone control connection closed."); });
    // Autosync is disabled. Drain protocol acknowledgements without retaining content.
    this.control.on("data", () => {});
    const parser = new VideoParser();
    this.video.on("data", (chunk: Buffer) => {
      try { for (const event of parser.push(chunk)) this.onEvent(event); }
      catch (e) { this.onFailure((e as Error).message); }
    });
    this.video.resume();
  }

  private openVideo(signal: AbortSignal): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: this.port });
      socket.setNoDelay(true);
      const timeout = setTimeout(() => fail(new Error("Video handshake timed out.")), 750);
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", aborted); socket.off("error", fail); socket.off("close", ended); socket.off("data", ready); };
      const fail = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
      const aborted = () => fail(new Error("Connection cancelled."));
      const ended = () => fail(new Error("Video socket not ready."));
      const ready = (chunk: Buffer) => {
        socket.pause(); cleanup();
        if (chunk[0] !== 0) { socket.destroy(); reject(new Error("Invalid scrcpy handshake.")); return; }
        if (chunk.length > 1) socket.unshift(chunk.subarray(1));
        resolve(socket);
      };
      socket.once("data", ready); socket.once("error", fail); socket.once("close", ended);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  async readLockState(signal: AbortSignal): Promise<LockState> {
    if (this.closed || !this.transport || !this.control || this.control.destroyed) return "unknown";
    const result = await runChecked(this.adb, ["-s", this.transport, "shell", "dumpsys", "window", "policy"], {
      timeoutMs: 1000, maxOutputBytes: 64 * 1024, signal,
    });
    if (this.closed || signal.aborted) return "unknown";
    return parseLockState(result.stdout);
  }

  async pasteFile(localPath: string, mime: string, signal: AbortSignal): Promise<boolean> {
    const work = this.performPasteFile(localPath, mime, signal);
    this.pastePending = work;
    try { return await work; }
    finally { if (this.pastePending === work) this.pastePending = undefined; }
  }

  private async performPasteFile(localPath: string, mime: string, signal: AbortSignal): Promise<boolean> {
    this.check(signal);
    if (!this.transport || !this.control || this.control.destroyed) throw new Error("Connect your phone first.");
    // Never stage another upload while a previous device path may still exist.
    if (this.pasteCleanup.size) await this.cleanupPasteTransfers();
    this.check(signal);
    const identity = await runChecked(this.adb, ["-s", this.transport, "shell", "getprop", "ro.serialno"], { timeoutMs: 3000, signal });
    if (identity.stdout.trim() !== this.serial) throw new Error("The connected device is not the configured phone.");
    const packageName = "ai.hooware.droiddock.paste";
    const installed = await runChecked(this.adb, ["-s", this.transport, "shell", "pm", "path", packageName], { timeoutMs: 3000, signal });
    if (!installed.stdout.includes(`package:`)) throw new Error("Install the DroidDock paste helper before pasting files.");
    const id = randomBytes(16).toString("hex");
    const remote = `/data/local/tmp/droiddock-paste-${id}`;
    const privateFile = `files/paste/${id}`;
    // A failed push or copy can still leave a partial file. Keep the paths
    // until removal succeeds, including across a disconnected session retry.
    const pending = { remote: true, privateFile: false };
    this.pasteCleanup.set(id, pending);
    const run = (args: string[], timeoutMs = 5000, cancellable = true) => runChecked(this.adb, ["-s", this.transport, ...args], {
      timeoutMs, maxOutputBytes: 4096, ...(cancellable ? { signal } : {}),
    });
    let cleanupPending = false;
    try {
      await run(["push", localPath, remote], 60000);
      this.check(signal);
      await run(["shell", "run-as", packageName, "mkdir", "-p", "files/paste"]);
      pending.privateFile = true;
      await run(["shell", "run-as", packageName, "cp", remote, privateFile]);
      this.check(signal);
      const result = await run(["shell", "am", "broadcast", "-a", "ai.hooware.droiddock.paste.SET_CLIP",
        "-n", `${packageName}/.PasteReceiver`, "--es", "id", id, "--es", "mime", mime]);
      if (!/\bresult=1\b/.test(result.stdout)) throw new Error("The phone could not prepare rich clipboard content.");
      // The clipboard URI now needs the helper-private file until another
      // paste replaces it; the helper bounds its retained private files.
      pending.privateFile = false;
      this.check(signal);
      this.input({ type: "key", key: "paste" });
    } finally {
      try { await this.cleanupPasteTransfers(); }
      catch { cleanupPending = true; }
    }
    return cleanupPending;
  }

  private async cleanupPasteTransfers(): Promise<void> {
    if (!this.pasteCleanup.size) return;
    await this.cleanupTransport();
    const packageName = "ai.hooware.droiddock.paste";
    for (const [id, pending] of this.pasteCleanup) {
      if (pending.remote) {
        try { await this.command(["shell", "rm", "-f", `/data/local/tmp/droiddock-paste-${id}`], 3000); pending.remote = false; }
        catch { /* Keep this exact path for the next verified-phone retry. */ }
      }
      if (pending.privateFile) {
        try { await this.command(["shell", "run-as", packageName, "rm", "-f", `files/paste/${id}`], 3000); pending.privateFile = false; }
        catch { /* Keep this exact path for the next verified-phone retry. */ }
      }
      if (!pending.remote && !pending.privateFile) this.pasteCleanup.delete(id);
    }
    if (this.pasteCleanup.size) throw new Error("Phone paste cleanup could not be confirmed.");
  }

  input(value: unknown): void {
    if (this.closed || !this.control || this.control.destroyed) throw new Error("Connect your phone first.");
    if (this.control.writableLength > 65536) throw new Error("Phone input is congested. Reconnect.");
    for (const message of encodeControl(value)) this.control.write(message);
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.video?.destroy(); this.control?.destroy(); this.child?.kill();
    await this.pastePending?.catch(() => {});
    let cleanupFailed = false;
    try {
      if (this.port || this.forwardMayExist) {
        const forwards = await runChecked(this.adb, ["forward", "--list"], { timeoutMs: 3000 });
        const knownPort = Number.isInteger(this.port) && this.port > 0 && this.port <= 65535;
        const owned = forwards.stdout.split(/\r?\n/).find(line => {
          const [transport, local, remote] = line.trim().split(/\s+/);
          return transport === this.forwardTransport && remote === `localabstract:scrcpy_${this.scid}` && (!knownPort || local === `tcp:${this.port}`);
        });
        // ADB removes forwards when their transport disconnects. A reused port
        // belongs to someone else and must never be removed by this old session.
        if (!owned) { this.port = 0; this.forwardMayExist = false; }
        else {
          const local = owned.trim().split(/\s+/)[1]!;
          if (!/^tcp:\d+$/.test(local)) throw new Error("Invalid cleanup tunnel.");
          this.port = Number(local.slice(4));
          if (this.port < 1 || this.port > 65535) throw new Error("Invalid cleanup tunnel.");
        }
      }
      if (this.port || this.remoteMayExist) await this.cleanupTransport();
      if (this.port) { await this.command(["forward", "--remove", `tcp:${this.port}`], 3000); this.port = 0; this.forwardMayExist = false; }
      if (this.remoteMayExist) { await this.command(["shell", "rm", "-f", this.remote]); this.remoteMayExist = false; }
    } catch { cleanupFailed = true; }
    try { await this.cleanupPasteTransfers(); }
    catch { cleanupFailed = true; }
    if (cleanupFailed) {
      throw new Error("Phone cleanup could not be confirmed. Restore the phone connection and select Connect to retry cleanup.");
    }
  }
}
