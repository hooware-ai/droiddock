// Adapter for the unmodified scrcpy 4.1 server. Keep upstream wire details here.
export const SCRCPY_VERSION = "4.1";
export const SERVER_SHA256 = "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae";
const MAX_PACKET = 8 * 1024 * 1024;
export type VideoEvent = { type: "video"; codec: "h264"; width: number; height: number } | { type: "packet"; data: Buffer };

export class VideoParser {
  private buffer: Buffer = Buffer.alloc(0);
  private codecRead = false;
  push(chunk: Buffer): VideoEvent[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: VideoEvent[] = [];
    if (!this.codecRead) {
      if (this.buffer.length < 4) return events;
      if (this.buffer.readUInt32BE(0) !== 0x68323634) throw new Error("Expected scrcpy H.264 stream.");
      this.buffer = this.buffer.subarray(4);
      this.codecRead = true;
    }
    while (this.buffer.length >= 12) {
      if (this.buffer[0]! & 0x80) {
        const width = this.buffer.readUInt32BE(4);
        const height = this.buffer.readUInt32BE(8);
        if (!width || !height || width > 8192 || height > 8192) throw new Error("Invalid video dimensions.");
        events.push({ type: "video", codec: "h264", width, height });
        this.buffer = this.buffer.subarray(12);
        continue;
      }
      const size = this.buffer.readUInt32BE(8);
      if (!size || size > MAX_PACKET) throw new Error("Invalid scrcpy packet size.");
      if (this.buffer.length < size + 12) break;
      const packet = Buffer.from(this.buffer.subarray(0, size + 12));
      // Stable DroidDock envelope: config bit63, key bit62, timestamp below.
      const raw = packet.readBigUInt64BE(0);
      packet.writeBigUInt64BE((raw & ((1n << 61n) - 1n)) | ((raw & (3n << 61n)) << 1n), 0);
      events.push({ type: "packet", data: packet });
      this.buffer = this.buffer.subarray(size + 12);
    }
    if (this.buffer.length > MAX_PACKET + 12) throw new Error("Video buffer limit exceeded.");
    return events;
  }
}

const KEYS: Record<string, number> = { home: 3, back: 4, recents: 187, volumeUp: 24, volumeDown: 25, power: 26, enter: 66, backspace: 67, forwardDelete: 112, tab: 61, up: 19, down: 20, left: 21, right: 22, pageUp: 92, pageDown: 93, moveHome: 122, moveEnd: 123, paste: 279 };
// Shift may extend a text selection only with these keys. The server owns the meta state.
const SELECTION_KEYS = new Set(["up", "down", "left", "right", "moveHome", "moveEnd", "pageUp", "pageDown"]);
const META_SHIFT_LEFT = 0x41; // Android META_SHIFT_ON | META_SHIFT_LEFT_ON.
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error("Invalid input coordinate or action.");
  return value;
}
function position(m: Record<string, unknown>, out: Buffer, offset: number): void {
  const w = integer(m.width, 1, 8192), h = integer(m.height, 1, 8192);
  out.writeUInt32BE(integer(m.x, 0, w - 1), offset);
  out.writeUInt32BE(integer(m.y, 0, h - 1), offset + 4);
  out.writeUInt16BE(w, offset + 8);
  out.writeUInt16BE(h, offset + 10);
}

export function encodeControl(input: unknown): Buffer[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid control message.");
  const m = input as Record<string, unknown>;
  if (m.type === "pin") {
    // Validate the entire request before creating any key events. Never echo digits.
    if (typeof m.digits !== "string" || !/^[0-9]{1,64}$/.test(m.digits)) throw new Error("PIN must contain 1 to 64 digits.");
    return [...m.digits].flatMap(digit => [0, 1].map(action => {
      const b = Buffer.alloc(14); b[1] = action;
      b.writeUInt32BE(7 + Number(digit), 2); // Android KEYCODE_0 through KEYCODE_9.
      return b;
    }));
  }
  if (m.type === "key") {
    if (typeof m.key !== "string" || !Object.hasOwn(KEYS, m.key)) throw new Error("Unsupported key.");
    if (m.shift !== undefined && (typeof m.shift !== "boolean" || !SELECTION_KEYS.has(m.key))) throw new Error("Shift is only supported with navigation keys.");
    const metaState = m.shift ? META_SHIFT_LEFT : 0;
    return [0, 1].map(action => {
      const b = Buffer.alloc(14); b[1] = action; b.writeUInt32BE(KEYS[m.key as string]!, 2); b.writeUInt32BE(metaState, 10); return b;
    });
  }
  if (m.type === "text") {
    if (typeof m.text !== "string" || !m.text || Buffer.byteLength(m.text) > 300) throw new Error("Text must be between 1 and 300 UTF-8 bytes.");
    const text = Buffer.from(m.text); const b = Buffer.alloc(5 + text.length);
    b[0] = 1; b.writeUInt32BE(text.length, 1); text.copy(b, 5); return [b];
  }
  if (m.type === "paste") {
    if (typeof m.text !== "string" || !m.text || Buffer.byteLength(m.text) > 65536) throw new Error("Paste must be between 1 and 65536 UTF-8 bytes.");
    const text = Buffer.from(m.text); const b = Buffer.alloc(14 + text.length);
    // SET_CLIPBOARD: sequence 0 (no acknowledgement), paste=true. The server
    // sets the clipboard before injecting PASTE, preserving Unicode and order.
    b[0] = 9; b[9] = 1; b.writeUInt32BE(text.length, 10); text.copy(b, 14);
    return [b];
  }
  if (m.type === "touch") {
    const action = integer(m.action, 0, 2); const b = Buffer.alloc(32);
    const pointerId = m.pointerId === undefined ? 0 : integer(m.pointerId, 0, 2);
    b[0] = 2; b[1] = action; b.writeBigUInt64BE(BigInt(pointerId), 2);
    position(m, b, 10); b.writeUInt16BE(action === 1 ? 0 : 65535, 22);
    return [b];
  }
  if (m.type === "scroll") {
    const b = Buffer.alloc(21); b[0] = 3; position(m, b, 1);
    for (const [key, offset] of [["dx", 13], ["dy", 15]] as const) {
      const value = m[key];
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1) throw new Error("Invalid scroll amount.");
      // scrcpy 4.x stores scroll in units of 1/2048 (full range is +/-16).
      b.writeInt16BE(Math.round(value * 2048), offset);
    }
    return [b];
  }
  throw new Error("Unsupported control message.");
}

// Explicit copy from phone. scrcpy 4.1 GET_CLIPBOARD is [8, copyKey]; the
// device replies with CLIPBOARD [0, u32 length, UTF-8], truncated server-side
// to 262,139 bytes, and sends nothing when the clipboard holds no text.
export const CLIPBOARD_TEXT_MAX_BYTES = (1 << 18) - 5;
export type CopySource = "selection" | "clipboard";
export function encodeGetClipboard(source: CopySource): Buffer {
  // "selection" injects Android COPY first; CUT is intentionally unreachable.
  if (source !== "selection" && source !== "clipboard") throw new Error("Unsupported copy source.");
  return Buffer.from([8, source === "selection" ? 1 : 0]);
}

export const COPY_MESSAGES = {
  busy: "A copy from the phone is already in progress.",
  timeout: "No text came back from the phone within 5 seconds. Its clipboard may be empty or hold non-text content, or Android blocked access. Disconnect and connect again to copy again.",
  reconnect: "Copy from phone needs a fresh connection. Disconnect and connect again to copy.",
} as const;

// Carries only the fixed COPY_MESSAGES text, never clipboard content.
export class CopyFromPhoneError extends Error {
  constructor(message: string) { super(message); this.name = "CopyFromPhoneError"; }
}

export class DeviceProtocolError extends Error {
  constructor() { super("Unexpected phone control message."); this.name = "DeviceProtocolError"; }
}

// Bounded incremental parser for the control socket's device messages. Only
// CLIPBOARD is expected: pastes use sequence 0 (no ACK) and UHID is never used.
// Each frame is copied straight into a buffer sized from its validated header,
// so at most 5 + CLIPBOARD_TEXT_MAX_BYTES bytes are held, whatever the chunking.
export class DeviceMessageParser {
  private readonly header = Buffer.alloc(5);
  private headerLength = 0;
  private body?: Buffer;
  private bodyLength = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  get bufferedBytes(): number { return this.headerLength + (this.body?.length ?? 0); }
  push(chunk: Buffer): string[] {
    const texts: string[] = [];
    let offset = 0;
    while (offset < chunk.length || (this.body && this.bodyLength === this.body.length)) {
      if (!this.body) {
        const take = Math.min(5 - this.headerLength, chunk.length - offset);
        chunk.copy(this.header, this.headerLength, offset, offset + take);
        this.headerLength += take; offset += take;
        if (this.header[0] !== 0) throw new DeviceProtocolError();
        if (this.headerLength < 5) break;
        const length = this.header.readUInt32BE(1);
        if (length > CLIPBOARD_TEXT_MAX_BYTES) throw new DeviceProtocolError();
        this.body = Buffer.alloc(length); this.bodyLength = 0;
      }
      const take = Math.min(this.body.length - this.bodyLength, chunk.length - offset);
      chunk.copy(this.body, this.bodyLength, offset, offset + take);
      this.bodyLength += take; offset += take;
      if (this.bodyLength < this.body.length) break;
      let text: string;
      try { text = this.decoder.decode(this.body); }
      catch { throw new DeviceProtocolError(); }
      texts.push(text);
      this.body = undefined; this.bodyLength = 0; this.headerLength = 0;
    }
    return texts;
  }
}
