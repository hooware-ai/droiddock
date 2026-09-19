export type LockState = "locked-awake" | "unlocked" | "other" | "unknown";
export interface LockUpdate { type: "lockState"; state: LockState; suspended: boolean }

// This deliberately recognizes one documented Android dump shape. Other device
// implementations must remain unknown instead of guessing from unrelated fields.
export function parseLockState(output: string): LockState {
  if (Buffer.byteLength(output, "utf8") > 64 * 1024) return "unknown";
  const lines = output.split(/\r?\n/);
  const headers = lines.flatMap((line, index) => /^\s*KeyguardServiceDelegate:?\s*$/.test(line) ? [index] : []);
  if (headers.length !== 1) return "unknown";
  const start = headers[0], indent = lines[start].search(/\S/);
  const values = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (line.search(/\S/) <= indent) break;
    const match = /^\s*(showing|occluded|screenState|interactiveState)=(\S+)\s*$/.exec(line);
    if (!match) {
      if (/^\s*(showing|occluded|screenState|interactiveState)\b/.test(line)) return "unknown";
      continue;
    }
    if (values.has(match[1])) return "unknown";
    values.set(match[1], match[2]);
  }
  const showing = values.get("showing"), occluded = values.get("occluded");
  const screen = values.get("screenState"), interactive = values.get("interactiveState");
  if (!/^(true|false)$/.test(showing ?? "") || !/^(true|false)$/.test(occluded ?? "") ||
      !/^SCREEN_STATE_(OFF|TURNING_ON|ON|TURNING_OFF)$/.test(screen ?? "") ||
      !/^INTERACTIVE_STATE_(SLEEP|WAKING|AWAKE|GOING_TO_SLEEP)$/.test(interactive ?? "")) return "unknown";
  const outerOccluded = [...output.matchAll(/\bmKeyguardOccluded=([^\s]+)/g)];
  if (outerOccluded.length > 1 || (outerOccluded.length === 1 && outerOccluded[0][1] !== occluded)) return "unknown";
  // Screen power and interactivity are independent: an always-on display can
  // remain ON while asleep. Only ON plus AWAKE qualifies for assistance.
  if (showing === "false") return "unlocked";
  return occluded === "false" && screen === "SCREEN_STATE_ON" && interactive === "INTERACTIVE_STATE_AWAKE" ? "locked-awake" : "other";
}

type Reader = (signal: AbortSignal) => Promise<LockState>;
interface Clock {
  now(): number;
  schedule(callback: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}
const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: timer => clearTimeout(timer as NodeJS.Timeout),
};

export class LockStateMonitor {
  private enabled = false;
  private visible = false;
  private reader?: Reader;
  private timer?: unknown;
  private active?: AbortController;
  private generation = 0;
  private failures = 0;
  private nextAt = 0;
  private lastStarted = -Infinity;
  private lastUpdate?: LockUpdate;

  constructor(private publish: (update: LockUpdate) => void, private clock: Clock = systemClock) {}

  subscribe(enabled: boolean, visible: boolean): void {
    if (this.enabled === enabled && this.visible === visible && this.lastUpdate) return;
    const toggled = this.enabled !== enabled;
    this.invalidate();
    this.enabled = enabled; this.visible = visible;
    if (toggled) { this.failures = 0; this.nextAt = 0; }
    this.emit("unknown");
    this.schedule();
  }

  connected(reader?: Reader): void {
    if (this.reader === reader) return;
    this.invalidate();
    this.reader = reader;
    if (reader) { this.failures = 0; this.nextAt = 0; }
    this.emit("unknown");
    this.schedule();
  }

  reset(): void {
    this.invalidate();
    this.reader = undefined;
    this.enabled = false; this.visible = false;
    this.failures = 0; this.nextAt = 0; this.lastUpdate = undefined;
  }

  private invalidate(): void {
    this.generation++;
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined;
    this.active?.abort();
  }

  private emit(state: LockState): void {
    const suspended = this.failures >= 3;
    if (this.lastUpdate?.state === state && this.lastUpdate.suspended === suspended) return;
    this.lastUpdate = { type: "lockState", state, suspended };
    this.publish(this.lastUpdate);
  }

  private schedule(): void {
    if (!this.enabled || !this.visible || !this.reader || this.failures >= 3 || this.active || this.timer !== undefined) return;
    const wait = Math.max(0, this.nextAt - this.clock.now(), this.lastStarted + 2000 - this.clock.now());
    this.timer = this.clock.schedule(() => { this.timer = undefined; void this.poll(); }, wait);
  }

  private async poll(): Promise<void> {
    if (!this.enabled || !this.visible || !this.reader || this.failures >= 3 || this.active) return;
    const generation = this.generation, controller = new AbortController();
    this.active = controller;
    this.lastStarted = this.clock.now();
    try {
      const state = await this.reader(controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      if (state === "unknown") this.failed();
      else { this.failures = 0; this.nextAt = this.clock.now() + 2000; this.emit(state); }
    } catch {
      if (generation === this.generation && !controller.signal.aborted) this.failed();
    } finally {
      this.active = undefined;
      this.schedule();
    }
  }

  private failed(): void {
    this.failures++;
    this.nextAt = this.clock.now() + 10000;
    this.emit("unknown");
  }
}
