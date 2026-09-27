import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The only browser files the local service serves.
export const PUBLIC_ASSETS = ["index.html", "app.js", "styles.css"] as const;

export function readPublicAssets(root: string): Map<string, Buffer> {
  return new Map(PUBLIC_ASSETS.map(name => [name, readFileSync(join(root, "droiddock/public", name))]));
}

export const RESTART_NEEDED = "Running DroidDock was started from a different build of this checkout. Restart needed: finish or disconnect its phone session, then rerun scripts/Install-DroidDock.ps1 to restart it. The running service was left unchanged.";

// Non-secret matching aid, like installationId: a running service and the checkout
// match only when the compiled server code and the served browser assets are identical.
export function buildIdentity(root: string, assets: Map<string, Buffer> = readPublicAssets(root)): string {
  const hash = createHash("sha256");
  const add = (name: string, data: Buffer) => { hash.update(`${name}\0${data.length}\0`); hash.update(data); };
  const dist = join(root, "dist");
  const compiled = existsSync(dist) ? readdirSync(dist, { recursive: true, encoding: "utf8" })
    .map(file => file.replaceAll("\\", "/")).filter(file => file.endsWith(".js")).sort() : [];
  for (const file of compiled) add(`dist/${file}`, readFileSync(join(dist, file)));
  for (const name of PUBLIC_ASSETS) add(`public/${name}`, assets.get(name)!);
  return hash.digest("hex").slice(0, 16);
}
