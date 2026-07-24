// Per-device model inventory for dynamic clients (opencode, pi) — see
// DeviceModelInventory in @codecast/shared/contracts. Each client's own listing
// command is the honest source of what THIS machine can launch (its catalog
// filtered by the API keys / logins present here), so the daemon collects it and
// ships it on the heartbeat. The payload is a few hundred ids (~10KB), so it
// rides the beat only when its hash changes: once after boot, then whenever a
// periodic recollection sees a different set (new login, upgraded client).

import { execFile } from "child_process";
import crypto from "crypto";
import { AGENT_CLIENTS, type DeviceModelInventory } from "@codecast/shared/contracts";
import { hasBin } from "./doctorClients.js";

const REFRESH_MS = 6 * 60 * 60 * 1000;
const COLLECT_TIMEOUT_MS = 20000;
const MAX_IDS_PER_CLIENT = 800;

/** `opencode models` prints one `provider/model` id per line. */
export function parseOpencodeModels(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.trim()).filter((l) => /^\S+\/\S+$/.test(l));
}

/** `pi --list-models` prints an aligned table: provider, model, then capability
 *  columns. Skip the header row and join the first two columns. */
export function parsePiModels(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[0] !== "provider" && /^[a-z0-9]/.test(cols[0]))
    .map((cols) => `${cols[0]}/${cols[1]}`);
}

const COLLECTORS: { id: "opencode" | "pi"; args: string[]; parse: (stdout: string) => string[] }[] = [
  { id: "opencode", args: ["models"], parse: parseOpencodeModels },
  { id: "pi", args: ["--list-models"], parse: parsePiModels },
];

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: COLLECT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

let cached: DeviceModelInventory | null = null;
let lastCollectedAt = 0;
let lastSentHash: string | null = null;
let inFlight = false;

/** Collect every installed dynamic client's listing. Exported for tests/doctor. */
export async function collectModelInventory(): Promise<DeviceModelInventory | null> {
  const clients: DeviceModelInventory["clients"] = {};
  for (const c of COLLECTORS) {
    const binary = AGENT_CLIENTS[c.id].binary;
    if (!hasBin(binary)) continue;
    try {
      const ids = [...new Set(c.parse(await run(binary, c.args)))].sort().slice(0, MAX_IDS_PER_CLIENT);
      if (ids.length > 0) clients[c.id] = ids;
    } catch {
      // A hung/failed listing just leaves this client out; the next refresh retries.
    }
  }
  if (Object.keys(clients).length === 0) return null;
  const hash = crypto.createHash("sha1").update(JSON.stringify(clients)).digest("hex").slice(0, 16);
  return { hash, collected_at: Date.now(), clients };
}

/** Kick a background recollection when the cache is stale. Called per heartbeat;
 *  a fresh result surfaces on the NEXT beat via pendingModelInventoryPayload. */
export function ensureModelInventoryFresh(): void {
  if (inFlight || Date.now() - lastCollectedAt < REFRESH_MS) return;
  inFlight = true;
  void collectModelInventory()
    .then((inv) => {
      lastCollectedAt = Date.now();
      if (inv) cached = inv;
    })
    .finally(() => {
      inFlight = false;
    });
}

/** The inventory to attach to this beat — only when the server hasn't seen it. */
export function pendingModelInventoryPayload(): DeviceModelInventory | undefined {
  return cached && cached.hash !== lastSentHash ? cached : undefined;
}

/** Record a successful heartbeat delivery so the payload stops riding the beat. */
export function markModelInventorySent(hash: string): void {
  lastSentHash = hash;
}
