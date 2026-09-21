import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("ledger writes and legacy position reads follow CODECAST_DIR after import", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-rebinding-"));
  try {
    const modulePath = new URL("./syncLedger.ts", import.meta.url).pathname;
    const script = `
      const fs = await import("node:fs");
      const path = await import("node:path");
      const root = ${JSON.stringify(root)};
      const a = path.join(root, "a"), b = path.join(root, "b");
      fs.mkdirSync(a); fs.mkdirSync(b);
      const transcript = path.join(root, "session.jsonl");
      fs.writeFileSync(transcript, "{}");
      fs.writeFileSync(path.join(a, "positions.json"), JSON.stringify({ legacy: 1 }));
      fs.writeFileSync(path.join(b, "positions.json"), JSON.stringify({ legacy: 2 }));
      process.env.CODECAST_DIR = a;
      const ledger = await import(${JSON.stringify(modulePath)});
      if (ledger.getSyncRecord("legacy").lastSyncedPosition !== 1) throw Error("A legacy");
      ledger.updateSyncRecord(transcript, { lastSyncedPosition: 10 });
      process.env.CODECAST_DIR = b;
      if (ledger.getSyncRecord("legacy").lastSyncedPosition !== 2) throw Error("B legacy");
      if (ledger.getSyncRecord(transcript) !== null) throw Error("A leaked into B");
      ledger.updateSyncRecord(transcript, { lastSyncedPosition: 20 });
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { env: { ...process.env, CODECAST_DIR: root }, stdout: "pipe", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    const record = (dir: string) => JSON.parse(fs.readFileSync(path.join(root, dir, "sync-ledger.json"), "utf8"))[path.join(root, "session.jsonl")];
    expect(record("a").lastSyncedPosition).toBe(10);
    expect(record("b").lastSyncedPosition).toBe(20);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
