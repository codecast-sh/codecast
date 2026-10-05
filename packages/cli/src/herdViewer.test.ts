import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { claimHerdViewer, herdViewerAlive } from "./herdViewer.js";
import { runHerdCommand } from "./herdCommand.js";

test("viewer ownership is exclusive and a stale owner can be replaced", async () => {
  const dir = await mkdtemp("/tmp/herd-viewer-");
  const socket = `${dir}/herdr.sock`;
  try {
    expect(await herdViewerAlive(socket)).toBe(false);
    await writeFile(`${socket}.viewer`, "2147483647");
    expect(await herdViewerAlive(socket)).toBe(false);
    const release = await claimHerdViewer(socket);
    expect(await herdViewerAlive(socket)).toBe(true);
    await expect(claimHerdViewer(socket)).rejects.toThrow("already open");
    await release();
    expect(await herdViewerAlive(socket)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no-open never boots a server or a mirror", async () => {
  await runHerdCommand(null, { open: false });
});
