/**
 * A cloud host's own view of whether it is ready (HostReadiness), from files
 * on its disk: the mirror stamp, the host tools report, the host setup
 * outcome, and the logins a laptop pushed. It rides the host daemon's
 * heartbeat onto its device row, only when it changed, so the app's Machines
 * page can say what a host has without asking the laptop or ssh.
 *
 * The mirror stamp holds one entry per mirrored file (about 18,000), so the
 * files are re-read only when their modification times move.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { loginIdForHostPath, type HostReadiness } from "@codecast/shared/contracts";

const FILES = ["mirror.json", "host-tools.json", "host-setup.json", "host-setup-last.json", "agent-auth-origin.json"] as const;

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

export function readHostReadiness(codecastDir: string, castVersion?: string, now = Date.now()): HostReadiness {
  const at = (name: string) => path.join(codecastDir, name);
  const out: HostReadiness = { at: now, ...(castVersion ? { cast_version: castVersion } : {}) };
  const stamp = readJson(at("mirror.json"));
  if (stamp && typeof stamp.files === "object") {
    const entries = Object.entries(stamp.files as Record<string, any>);
    out.mirror = {
      complete: stamp.complete === true,
      files: entries.filter(([, f]) => !f?.removed).length,
      ...(stamp.applied_at ? { applied_at: String(stamp.applied_at) } : {}),
      host_edited: entries.filter(([, f]) => f?.host_edited).map(([p]) => p).slice(0, 20),
    };
  }
  const tools = readJson(at("host-tools.json"));
  if (tools && Array.isArray(tools.ok)) {
    out.tools = {
      ok: tools.ok.length,
      installed: Array.isArray(tools.installed) ? tools.installed.length : 0,
      missing: (Array.isArray(tools.missing) ? tools.missing : []).slice(0, 30).map((m: any) => ({ tool: String(m.tool), ...(m.referenced_by ? { referenced_by: String(m.referenced_by).slice(0, 120) } : {}) })),
      ...(tools.at ? { at: String(tools.at) } : {}),
    };
  }
  const applied = readJson(at("host-setup.json"));
  const last = readJson(at("host-setup-last.json"));
  if (applied || last) {
    out.setup = {
      ok: last ? last.ok !== false : true,
      ...(applied?.at ? { applied_at: String(applied.at) } : {}),
      ...(last?.step ? { step: String(last.step).slice(0, 120) } : {}),
      ...(last?.error ? { error: String(last.error).slice(-600) } : {}),
      ...(last?.at ? { at: String(last.at) } : {}),
      ...(Array.isArray(last?.packages) ? { packages: last.packages.slice(0, 30).map(String) } : {}),
      ...(Array.isArray(last?.services) ? { services: last.services.slice(0, 30).map(String) } : {}),
      ...(typeof last?.commands === "number" ? { commands: last.commands } : {}),
    };
  }
  const origin = readJson(at("agent-auth-origin.json"));
  const files = origin?.files && typeof origin.files === "object" ? Object.keys(origin.files) : Array.isArray(origin?.files) ? origin.files : [];
  if (files.length) out.logins = [...new Set(files.map((f: string) => loginIdForHostPath(f)))].sort() as string[];
  return out;
}

/**
 * The heartbeat's view: the readiness when it changed since the last beat that
 * carried it (or half an hour passed), else undefined. Files are re-read only
 * when one of their mtimes moved.
 */
export class HostReadinessReporter {
  private mtimes = "";
  private cached: HostReadiness | null = null;
  private sentHash = "";
  private sentAt = 0;

  constructor(private codecastDir: string, private castVersion?: string) {}

  next(now = Date.now()): HostReadiness | undefined {
    const mtimes = FILES.map((f) => { try { return fs.statSync(path.join(this.codecastDir, f)).mtimeMs; } catch { return 0; } }).join(",");
    if (mtimes !== this.mtimes || !this.cached) { this.cached = readHostReadiness(this.codecastDir, this.castVersion, now); this.mtimes = mtimes; }
    const { at: _, ...content } = this.cached;
    const hash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    if (hash === this.sentHash && now - this.sentAt < 30 * 60_000) return undefined;
    this.sentHash = hash;
    this.sentAt = now;
    return { ...content, at: now };
  }
}
