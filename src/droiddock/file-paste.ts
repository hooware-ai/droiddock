import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_PASTE_FILE_BYTES = 16 * 1024 * 1024;

export class PasteFileError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function pasteMime(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value))
    throw new PasteFileError("Select one image or file to paste.", 415);
  return value.toLowerCase();
}

export async function stagePasteFile(req: IncomingMessage, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_PASTE_FILE_BYTES))
    throw new PasteFileError("Paste one file up to 16 MiB.", 413);
  const path = join(tmpdir(), `droiddock-paste-${randomUUID()}`);
  const handle = await open(path, "wx", 0o600);
  const cancel = () => req.destroy();
  signal.addEventListener("abort", cancel, { once: true });
  let complete = false;
  try {
    signal.throwIfAborted();
    let total = 0;
    for await (const chunk of req) {
      signal.throwIfAborted();
      total += chunk.length;
      if (total > MAX_PASTE_FILE_BYTES) throw new PasteFileError("Paste one file up to 16 MiB.", 413);
      let offset = 0;
      while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
    }
    signal.throwIfAborted();
    if (total === 0) throw new PasteFileError("The clipboard file is empty.", 400);
    complete = true;
    return path;
  } finally {
    signal.removeEventListener("abort", cancel);
    await handle.close();
    if (!complete) await unlink(path).catch(() => {});
  }
}
