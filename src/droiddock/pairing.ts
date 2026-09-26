import { runCommand, type CommandResult, type RunOptions } from "../process.js";

export type PairingResult = "paired" | "failed" | "expired" | "unavailable";

export interface PairingRequest {
  code: string;
  manualEndpoint?: string;
  expiresAtMs?: number;
  signal?: AbortSignal;
}

type Runner = (command: string, args: string[], options: RunOptions) => Promise<CommandResult>;

const ATTEMPT_MS = 15_000;
const DISCOVERY_MS = 5_000;
const DISCOVERY_BYTES = 32 * 1024;
const PAIR_BYTES = 4 * 1024;
let attemptActive = false;

function endpoint(value: string): { value: string; address: string } | undefined {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value);
  if (!match) return;
  const octets = match[1].split(".").map(Number);
  const port = Number(match[2]);
  if (octets.some((part, index) => part > 255 || String(part) !== match[1].split(".")[index]) ||
      octets[0] === 0 || octets[0] === 127 || octets[0] >= 224 ||
      port < 1 || port > 65535 || String(port) !== match[2]) return;
  return { value, address: match[1] };
}

type Discovery = { kind: "candidate"; endpoint: string } | { kind: "missing" | "ambiguous" };

// Mirror the conservative #41 recovery evidence: one configured connect row,
// one pairing row, and the same canonical IPv4 address. No identity is claimed.
export function discoverPairingEndpoint(devicesText: string, servicesText: string, serial: string): Discovery {
  if (!/^[A-Za-z0-9]+$/.test(serial)) return { kind: "ambiguous" };
  if (devicesText.split(/\r?\n/).some(line => line.startsWith(serial) && /^\s+\S+/.test(line.slice(serial.length)))) {
    return { kind: "ambiguous" };
  }
  const connect: { value: string; address: string }[] = [];
  const pairing: { value: string; address: string }[] = [];
  for (const row of servicesText.split(/\r?\n/)) {
    const line = row.trim();
    const fields = line.split(/\s+/);
    const configured = fields[0]?.startsWith(`adb-${serial}-`) && /^_adb-tls-connect\._tcp\.?$/.test(fields[1] ?? "");
    const pair = /^_adb-tls-pairing\._tcp\.?$/.test(fields[1] ?? "");
    if (!configured && !pair) continue;
    const parsed = fields.length === 3 ? endpoint(fields[2]) : undefined;
    if (!parsed) return { kind: "ambiguous" };
    (configured ? connect : pairing).push(parsed);
  }
  if (connect.length === 0 && pairing.length === 0) return { kind: "missing" };
  if (connect.length !== 1 || pairing.length !== 1 || connect[0].address !== pairing[0].address) {
    return { kind: "ambiguous" };
  }
  return { kind: "candidate", endpoint: pairing[0].value };
}

function confirmsPairing(result: CommandResult, selectedEndpoint: string): boolean {
  if (result.code !== 0) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  const escaped = selectedEndpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !/\bFailed\b|\berror:/i.test(output) &&
    new RegExp(`Successfully paired to ${escaped} \\[guid=[^\\]\\r\\n]{1,128}\\]`).test(output);
}

/** An explicit, single-use local attempt. This helper has no browser or session hook. */
export async function pairConfiguredPhone(
  adb: string, serial: string, request: PairingRequest, runner: Runner = runCommand,
): Promise<PairingResult> {
  if (attemptActive) return "unavailable";
  if (typeof request.code !== "string" || !/^\d{6}$/.test(request.code)) return "failed";
  if (!adb || !/^[A-Za-z0-9]+$/.test(serial)) return "unavailable";
  const manual = request.manualEndpoint === undefined ? undefined : endpoint(request.manualEndpoint);
  if (request.manualEndpoint !== undefined && !manual) return "unavailable";
  if (request.expiresAtMs !== undefined && (!Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= Date.now())) return "expired";
  if (request.signal?.aborted) return "unavailable";

  attemptActive = true;
  const controller = new AbortController();
  let expired = false;
  const cancel = () => controller.abort();
  request.signal?.addEventListener("abort", cancel, { once: true });
  const remaining = request.expiresAtMs === undefined ? ATTEMPT_MS : Math.min(ATTEMPT_MS, request.expiresAtMs - Date.now());
  const timer = setTimeout(() => { expired = true; controller.abort(); }, Math.max(1, remaining));
  try {
    const run = (args: string[], maxOutputBytes: number, timeoutMs: number, input?: string) =>
      runner(adb, args, { signal: controller.signal, timeoutMs, maxOutputBytes, input });
    const devices = await run(["devices", "-l"], DISCOVERY_BYTES, DISCOVERY_MS);
    if (controller.signal.aborted) return expired ? "expired" : "unavailable";
    if (devices.code !== 0) return "unavailable";
    if (discoverPairingEndpoint(devices.stdout, "", serial).kind === "ambiguous") return "unavailable";
    const services = await run(["mdns", "services"], DISCOVERY_BYTES, DISCOVERY_MS);
    if (controller.signal.aborted) return expired ? "expired" : "unavailable";
    const discovered = services.code === 0
      ? discoverPairingEndpoint(devices.stdout, services.stdout, serial)
      : { kind: "missing" as const };
    if (discovered.kind === "ambiguous") return "unavailable";
    if (discovered.kind === "candidate" && manual && discovered.endpoint !== manual.value) return "unavailable";
    const selectedEndpoint = discovered.kind === "candidate" ? discovered.endpoint : manual?.value;
    if (!selectedEndpoint) return "unavailable";
    const inputOptions = { value: `${request.code}\n` };
    try {
      // ADB reads the code from stdin when the fixed pair command has no code argument.
      const result = await run(["pair", selectedEndpoint], PAIR_BYTES, ATTEMPT_MS, inputOptions.value);
      if (controller.signal.aborted) return expired ? "expired" : "unavailable";
      return confirmsPairing(result, selectedEndpoint) ? "paired" : "failed";
    } finally {
      inputOptions.value = "";
    }
  } catch {
    return expired ? "expired" : "unavailable";
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", cancel);
    attemptActive = false;
  }
}
