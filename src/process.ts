import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    // This message reaches the browser. Command paths, arguments and output may
    // contain local usernames, device identifiers or other private data.
    super(`A required device command failed (exit ${result.code ?? "unknown"}). Check the phone connection and local tool installation.`);
    this.name = "CommandError";
    this.result = result;
  }
}

export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error("A required local command was cancelled.")); return; }
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd, env: { ...process.env, ...options.env },
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
      });
    } catch { reject(new Error("A required local command could not start. Check the local tool installation.")); return; }
    const timeoutMs = options.timeoutMs ?? 20000;
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    let stdout = "", stderr = "", outputBytes = 0;
    let failure: Error | undefined, settled = false;
    let escalation: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation);
      options.signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else resolve({ command, args, code: child.exitCode, stdout, stderr, durationMs: Date.now() - started });
    };
    const fail = (message: string) => {
      if (failure || settled) return;
      failure = new Error(message);
      child.kill();
      // A child or descendant can retain inherited pipes after the deadline.
      // Bound the wait independently from the close event and release our handles.
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        finish();
      }, 250);
    };
    const timer = setTimeout(() => fail("A required local command timed out. Check the phone connection and try again."), timeoutMs);
    const cancel = () => fail("A required local command was cancelled.");
    options.signal?.addEventListener("abort", cancel, { once: true });
    const collect = (chunk: string, target: "stdout" | "stderr") => {
      if (failure) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) { fail("A required local command produced too much output."); return; }
      if (target === "stdout") stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => collect(chunk, "stdout"));
    child.stderr.on("data", chunk => collect(chunk, "stderr"));
    child.stdin.on("error", () => fail("A required local command could not receive input."));
    child.on("error", () => {
      failure = new Error("A required local command could not start. Check the local tool installation.");
      finish();
    });
    child.on("close", finish);
    child.stdin.end(options.input);
  });
}

export async function runChecked(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new CommandError(result);
  }
  return result;
}
