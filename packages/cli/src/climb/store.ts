// Where a climb keeps its cache of runs, sealed against casual edits.
//
// Agents in the climb have a shell, and candidate code runs as the same user,
// so no file on this machine is out of their reach. The state is therefore
// only a cache (engine.ts): which filed attempt answers which run, read back
// and checked against the registry on every use. It lives under the CLI's
// own directory (`<config>/climbs/<hash of the run's climb dir>/`), which no
// prompt names and no runner is told, sealed with an HMAC so a casual edit
// stops the climb. The seal is tamper evidence, not a boundary: a process
// that reads the key can forge it, which is why nothing is decided on it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultConfigDir } from "../config/configDir.js";

export class StoreTampered extends Error {}

const root = () => path.join(defaultConfigDir(), "climbs");
/** The private directory of the climb whose handle (the run's `$run_dir/climb`) is `dir`. */
export const climbHome = (dir: string) => path.join(root(), crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16));

function key(): Buffer {
  const file = path.join(root(), ".key");
  try { return fs.readFileSync(file); } catch {}
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: "wx" }); } catch {}
  return fs.readFileSync(file);
}
const mac = (text: string) => crypto.createHmac("sha256", key()).update(text).digest("hex");

/** The sealed state, or null when there is none; a broken seal throws. */
export function readSealed<T>(dir: string): T | null {
  const file = path.join(climbHome(dir), "state.json");
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  let parsed: { seal?: string; body?: string };
  try { parsed = JSON.parse(raw); } catch { throw new StoreTampered("the climb's state is not readable JSON: it was changed outside cast climb"); }
  if (typeof parsed.body !== "string" || parsed.seal !== mac(parsed.body)) throw new StoreTampered("the climb's state was changed outside cast climb");
  return JSON.parse(parsed.body) as T;
}

export function writeSealed(dir: string, state: unknown): void {
  const home = climbHome(dir);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(state);
  const file = path.join(home, "state.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify({ seal: mac(body), body }));
  fs.renameSync(file + ".tmp", file);
}
