import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_PASTE_FILE_BYTES = 16 * 1024 * 1024;

export class PasteFileError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class HostPasteCleanup {
  private readonly paths = new Set<string>();
  constructor(private readonly remove: (path: string) => Promise<void> = unlink) {}
  track(path: string): void { this.paths.add(path); }
  get pending(): boolean { return this.paths.size > 0; }
  async retry(): Promise<boolean> {
    for (const path of this.paths) {
      try { await this.remove(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue; }
      this.paths.delete(path);
    }
    return !this.pending;
  }
}

export function pasteMime(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value))
    throw new PasteFileError("Select one image or file to paste.", 415);
  return value.toLowerCase();
}

interface StagingHandle {
  write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}
export interface StagingIo {
  directory(): string;
  open(path: string, flags: string, mode: number): Promise<StagingHandle>;
  unlink(path: string): Promise<void>;
}
const systemIo: StagingIo = { directory: tmpdir, open, unlink };

// Node filesystem errors name the temporary path, which contains the local
// account name on Windows. The browser only ever receives this fixed text.
function stagingFailure(): PasteFileError {
  return new PasteFileError("DroidDock could not prepare this file on the computer. Check free space and try again.", 500);
}

export async function stagePasteFile(req: IncomingMessage, signal: AbortSignal, onCreated: (path: string) => void = () => {},
  io: StagingIo = systemIo): Promise<string> {
  signal.throwIfAborted();
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_PASTE_FILE_BYTES))
    throw new PasteFileError("Paste one file up to 16 MiB.", 413);
  const path = join(io.directory(), `droiddock-paste-${randomUUID()}`);
  let handle: StagingHandle;
  try { handle = await io.open(path, "wx", 0o600); }
  catch { throw stagingFailure(); }
  const cancel = () => req.destroy();
  signal.addEventListener("abort", cancel, { once: true });
  let tracked = false, closed = false, complete = false;
  try {
    onCreated(path);
    tracked = true;
    signal.throwIfAborted();
    let total = 0;
    for await (const chunk of req) {
      signal.throwIfAborted();
      total += chunk.length;
      if (total > MAX_PASTE_FILE_BYTES) throw new PasteFileError("Paste one file up to 16 MiB.", 413);
      let offset = 0;
      while (offset < chunk.length) {
        try { offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten; }
        catch { throw stagingFailure(); }
      }
    }
    signal.throwIfAborted();
    if (total === 0) throw new PasteFileError("The clipboard file is empty.", 400);
    closed = true;
    try { await handle.close(); }
    catch { throw stagingFailure(); }
    complete = true;
    return path;
  } finally {
    signal.removeEventListener("abort", cancel);
    // Cleanup failures must not replace the original error. A tracked path is
    // retried by HostPasteCleanup; an untracked leftover still fails closed.
    if (!closed) await handle.close().catch(() => {});
    if (!complete) {
      try { await io.unlink(path); }
      catch (error) { if (!tracked && (error as NodeJS.ErrnoException).code !== "ENOENT") throw stagingFailure(); }
    }
  }
}
