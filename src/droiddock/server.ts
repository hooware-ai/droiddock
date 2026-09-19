import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { ScrcpySession } from "./session.js";
import { SCRCPY_VERSION } from "./protocol.js";
import { config } from "./config.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const installationId = createHash("sha256").update(resolve(root).toLowerCase()).digest("hex").slice(0, 16);
const configurationId = createHash("sha256").update(JSON.stringify([config.deviceSerial, config.adb, config.deviceName, config.port])).digest("hex").slice(0, 16);
// Both src/droiddock and dist/droiddock are two directories below the root.
const port = config.port;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("DROIDDOCK_PORT must be an integer from 1024 to 65535.");
const authority = `127.0.0.1:${port}`;
const origin = `http://${authority}`;
type State = "idle" | "connecting" | "connected" | "error";
let state: State = "idle", message = "Ready to connect your phone.";
let client: WebSocket | undefined;
let session: ScrcpySession | undefined;
let abort: AbortController | undefined;
let pending: Promise<void> | undefined;
let stopping: Promise<void> = Promise.resolve();
let startupTimer: NodeJS.Timeout | undefined;
let packetCount = 0;
let shuttingDown = false;
let connectionIntent = 0;
const cleanupSessions = new Set<ScrcpySession>();
const cleanupMessage = "Phone cleanup could not be confirmed. Restore the phone connection and select Connect to retry cleanup.";

const connectingProgress = new Set([
  "Finding the configured phone…",
  "Preparing the phone connection…",
  "Opening the video stream…",
]);
function startupTimeoutMs(): number {
  const value = Number(process.env.DROIDDOCK_STARTUP_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 50 && value <= 120000 ? value : 35000;
}
function status() { return { app: "DroidDock", type: "status", state, message, device: config.deviceName, version: SCRCPY_VERSION, packets: packetCount, installationId, configurationId, handoff: true }; }
function send(value: unknown) { if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); }
function setState(next: State, detail: string) {
  if (state === next && message === detail) return;
  state = next; message = detail; send(status());
}
function applyConnectingProgress(current: ScrcpySession, detail: string) {
  if (session !== current || state !== "connecting" || !connectingProgress.has(detail)) return;
  setState("connecting", detail);
}
async function cleanup(): Promise<void> {
  for (const old of cleanupSessions) {
    try { await old.stop(); cleanupSessions.delete(old); }
    catch { /* Retain only this session's resources for a later bounded retry. */ }
  }
}
function stop(next: State = "idle", detail = "Disconnected. Connect when you're ready."): Promise<void> {
  const intent = ++connectionIntent;
  const old = session, oldPending = pending;
  if (old) cleanupSessions.add(old);
  session = undefined; pending = undefined;
  abort?.abort(); abort = undefined;
  clearTimeout(startupTimer);
  if (cleanupSessions.size || oldPending) setState("connecting", "Disconnecting and cleaning up the phone connection…");
  else setState(next, detail);
  stopping = stopping.then(async () => {
    // Let any in-flight ADB allocation settle before removing this session's resources.
    await oldPending?.catch(() => {});
    await cleanup();
    if (intent === connectionIntent) setState(cleanupSessions.size ? "error" : next, cleanupSessions.size ? cleanupMessage : detail);
  });
  return stopping;
}
async function connect(): Promise<void> {
  const intent = connectionIntent;
  await stopping;
  if (intent !== connectionIntent || shuttingDown || session || !client || client.readyState !== WebSocket.OPEN) return;
  if (cleanupSessions.size) {
    setState("connecting", "Retrying phone connection cleanup…");
    stopping = stopping.then(cleanup);
    await stopping;
    if (intent !== connectionIntent || shuttingDown || session || !client || client.readyState !== WebSocket.OPEN) return;
    if (cleanupSessions.size) { setState("error", cleanupMessage); return; }
  }
  packetCount = 0;
  setState("connecting", "Finding the configured phone…");
  abort = new AbortController();
  const current = new ScrcpySession(root, event => {
    if (session !== current) return;
    if (event.type === "video") {
      clearTimeout(startupTimer);
      setState("connected", "Connected");
      send(event);
    } else if (client?.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > 2 * 1024 * 1024) {
        void stop("error", "The browser could not keep up with the stream. Reconnect to resume.");
        return;
      }
      packetCount++;
      client.send(event.data);
    }
  }, detail => { if (session === current) void stop("error", detail); }, detail => { applyConnectingProgress(current, detail); });
  session = current;
  startupTimer = setTimeout(() => { if (session === current) void stop("error", "Connection timed out. Check wireless debugging and reconnect."); }, startupTimeoutMs());
  pending = current.start(abort.signal).catch(error => {
    if (session === current) {
      const detail = error instanceof Error ? error.message : "Could not connect to the phone. Check the phone connection and local tool installation.";
      void stop("error", detail.includes("could not be reached") ? "Your phone is unreachable. Check Wi-Fi and enable Wireless debugging on the phone, then reconnect." : detail.slice(0, 600));
    }
  });
}

export function allowedRequest(req: Pick<IncomingMessage, "headers">, expected: string): boolean {
  return req.headers.host === expected && (!req.headers.origin || req.headers.origin === `http://${expected}`);
}
function reply(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value));
}
const assets: Record<string, [string, string]> = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/stream-stats.js": ["stream-stats.js", "text/javascript; charset=utf-8"], "/styles.css": ["styles.css", "text/css; charset=utf-8"] };
const http = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!allowedRequest(req, authority)) { reply(res, 403, { error: "Only the local DroidDock page can access this service." }); return; }
  try {
    if (req.url === "/api/status" && req.method === "GET") { reply(res, 200, status()); return; }
    if (req.url?.startsWith("/api/")) {
      if (req.method !== "POST" || req.headers["x-droiddock"] !== "1") { reply(res, 403, { error: "DroidDock request header required." }); return; }
      // Browsers control their own WebSocket. A delayed HTTP request from an old
      // page must never connect or disconnect the new controller's phone session.
      if ((req.url === "/api/connect" || req.url === "/api/disconnect") && (req.headers.origin || req.headers["sec-fetch-site"])) {
        reply(res, 409, { error: "This phone view needs to reconnect. Reload DroidDock and use Connect." }); return;
      }
      if (req.url === "/api/connect") {
        if (!client || client.readyState !== WebSocket.OPEN) { reply(res, 409, { error: "Open the DroidDock screen connection first." }); return; }
        await connect(); reply(res, 200, status()); return;
      }
      if (req.url === "/api/disconnect") { await stop(); reply(res, 200, status()); return; }
      if (req.url === "/api/shutdown") {
        if (cleanupSessions.size) { reply(res, 409, { error: cleanupMessage }); return; }
        if (client || session || state === "connecting" || state === "connected") { reply(res, 409, { error: "Close the controlling browser tab before restarting DroidDock." }); return; }
        reply(res, 200, { app: "DroidDock", stopping: true }); void shutdown(); return;
      }
      reply(res, 404, { error: "Unknown action." }); return;
    }
    const asset = assets[req.url ?? ""];
    if (req.method !== "GET" || !asset) { reply(res, 404, { error: "Not found." }); return; }
    const content = await readFile(join(root, "droiddock/public", asset[0]));
    res.writeHead(200, { "Content-Type": asset[1] }); res.end(content);
  } catch { reply(res, 500, { error: "DroidDock could not complete this request." }); }
});
http.requestTimeout = 10000;
http.headersTimeout = 10000;
// A 64KiB plain-text paste may expand sixfold when JSON escapes control characters.
const sockets = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
http.on("upgrade", (req, socket, head) => {
  const takeover = req.url === "/stream?takeover=1";
  if (shuttingDown || (req.url !== "/stream" && !takeover) || !allowedRequest(req, authority) || req.headers.origin !== origin || (!takeover && client && client.readyState !== WebSocket.CLOSED)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
  }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit("connection", ws));
});
sockets.on("connection", (ws: WebSocket) => {
  const previous = client;
  if (previous) {
    // Invalidate the old owner before cleanup or any asynchronous socket events.
    client = undefined;
    void stop();
    if (previous.readyState === WebSocket.OPEN) previous.send(JSON.stringify({ type: "moved", message: "Phone opened elsewhere." }));
    previous.close(4001, "Phone opened elsewhere");
  }
  client = ws;
  let alive = true, controls = 0;
  const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; controls = 0; ws.ping(); }, 15000);
  ws.on("pong", () => { alive = true; });
  send({ ...status(), snapshot: true });
  ws.on("message", (data, binary) => {
    if (client !== ws) return;
    try {
      if (binary || ++controls > 6000) throw new Error("Invalid input or input rate exceeded.");
      const input = JSON.parse(data.toString());
      if (input?.type === "connect") { void connect(); return; }
      if (input?.type === "disconnect") { void stop(); return; }
      if (state !== "connected" || !session) throw new Error("Connect your phone first.");
      session.input(input);
    } catch (error) { send({ type: "inputError", message: error instanceof SyntaxError ? "Invalid JSON control message." : (error as Error).message }); }
  });
  ws.on("error", () => ws.terminate());
  ws.on("close", () => {
    clearInterval(heartbeat);
    if (client === ws) { client = undefined; void stop(); }
  });
});
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  client?.terminate();
  await stop();
  if (cleanupSessions.size) {
    shuttingDown = false;
    setState("error", cleanupMessage);
    console.error("DroidDock remains open because phone cleanup could not be confirmed. Restore the phone connection and retry.");
    return;
  }
  sockets.close(); http.close();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
http.on("error", error => { console.error(`DroidDock could not listen on ${origin}: ${error.message}`); process.exitCode = 1; });
http.listen(port, "127.0.0.1", () => console.log(`DroidDock is ready at ${origin}`));
