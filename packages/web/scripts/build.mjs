#!/usr/bin/env node
/**
 * `bun run build` for web. The client build (dist/) and the SSR build
 * (dist-ssr/, vite.prerender.config.ts) read nothing of each other's, so they
 * run side by side; then the steps that read dist/ run in order. The SSR build
 * stays fail-open the way prerender.mjs makes it: when it fails here,
 * prerender tries it again itself and logs the failure.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITE = join(WEB_ROOT, "node_modules", "vite", "bin", "vite.js");

function node(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: WEB_ROOT, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const [client, ssr] = await Promise.all([node([VITE, "build"]), node([VITE, "build", "-c", "vite.prerender.config.ts"])]);
if (client !== 0) process.exit(client);

for (const step of [
  ["../../scripts/ci/verify-telemetry-key.mjs", "--target", "web"],
  ["scripts/precompress.mjs"],
  ["scripts/carry-assets.mjs"],
  ["scripts/prerender.mjs", ...(ssr === 0 ? ["--ssr-built"] : [])],
  ["scripts/indexnow.mjs"],
]) {
  const code = await node(step);
  if (code !== 0) process.exit(code);
}
