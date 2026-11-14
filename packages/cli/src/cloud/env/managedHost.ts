/**
 * Where `cast cloud` goes when no --host is named: a machine of this person's
 * own in codecast's account. The first run makes a key for it, asks the
 * backend to launch it (browser/codecastMachine.ts), registers it as a host
 * with provider "codecast" and provisions it like any other host. Later runs
 * find it in the registry and wake it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../../proc.js";
import { readHosts, upsertHost, type CloudHost } from "../../browser/cloudHost.js";
import { codecastMachine } from "../../browser/codecastMachine.js";

export const CODECAST_REGION = "us-west-2";

export function managedKeyPath(home = os.homedir()): string {
  return path.join(home, ".codecast", "cloud", "id_ed25519");
}

/** This laptop's key for its codecast machine, made on first use. */
export function ensureManagedKey(keyPath = managedKeyPath()): string {
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `cast-cloud@${os.hostname()}`, "-f", keyPath], { stdio: "ignore", timeout: 30_000 });
    if (r.status !== 0) throw new Error("ssh-keygen could not make a key for the cloud machine");
  }
  return fs.readFileSync(`${keyPath}.pub`, "utf-8").trim();
}

export interface ManagedHostDeps {
  hosts?: () => CloudHost[];
  upsert?: (h: CloudHost) => void;
  request?: (publicKey: string) => any;
  key?: () => { path: string; pub: string };
  /** Provision a host just registered (cast hosts provision). */
  provision?: (id: string) => Promise<void>;
}

/** The registered codecast machine, or a new one launched, registered and provisioned. */
export async function managedHost(log: (l: string) => void, deps: ManagedHostDeps = {}): Promise<CloudHost> {
  const existing = (deps.hosts ?? readHosts)().find((h) => h.provider === "codecast");
  if (existing) return existing;
  const key = deps.key?.() ?? { path: managedKeyPath(), pub: ensureManagedKey() };
  log("asking codecast for a cloud machine");
  const answer = (deps.request ?? ((pub) => codecastMachine("request", { ssh_public_key: pub })))(key.pub);
  const id: string | undefined = answer?.instance_id;
  if (!id) throw new Error("codecast did not return a machine");
  const host: CloudHost = {
    id, provider: "codecast", region: CODECAST_REGION, platform: "linux", user: "ubuntu", keyPath: key.path,
    ...(answer.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress ? { address: answer.Reservations[0].Instances[0].PublicIpAddress } : {}),
  };
  (deps.upsert ?? upsertHost)(host);
  log(`registered ${id}; setting it up (a first setup takes several minutes)`);
  await (deps.provision ?? (async (hostId) => {
    const { Command } = await import("commander");
    const { registerHostsCommand } = await import("../../hosts/cli.js");
    const program = new Command();
    registerHostsCommand(program);
    await program.parseAsync(["hosts", "provision", hostId], { from: "user" });
  }))(id);
  return (deps.hosts ?? readHosts)().find((h) => h.id === id) ?? host;
}
