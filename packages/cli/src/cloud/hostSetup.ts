/**
 * Declared machine setup for a cloud host: what the repo's
 * `.codecast/workspace.toml` `[host]` table and the person's own
 * `~/.codecast/host.toml` ask for (apt packages, systemd services, idempotent
 * commands), plus the laptop's login shell when it is not bash. A host applies
 * the merged spec once per change: the spec's hash is stamped in
 * `~/.codecast/host-setup.json`, so a wake whose spec is in step costs one
 * ssh round trip, and a changed spec (or a new host) applies it again.
 *
 * Every run also keeps `/etc/profile.d/codecast-cloud.sh` current: the host's
 * own tool directories on PATH and CODECAST_CLOUD=1 in every login shell,
 * whatever the mirrored rc files say, because the mirror now replaces the
 * host's ~/.bashrc with the laptop's and that file was where installers put
 * their PATH lines.
 *
 * A failed step is reported with its output tail and leaves the stamp alone,
 * so the next wake tries again; it never stops a session from starting.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { sshBase, type RemoteHost } from "../remote/session-move.js";
import { parseManifest, parseManifestText } from "../workspace/manifest.js";
import type { HostSpec } from "../workspace/types.js";

/** Bumped when the script's meaning changes, so every host re-applies. */
export const HOST_SETUP_VERSION = 1;
export const PERSONAL_HOST_SPEC = ".codecast/host.toml";

export interface ResolvedHostSpec extends HostSpec {
  /** The laptop's login shell when the host must switch to it (zsh, fish). */
  shell?: string;
}

/** The repo's [host] and the person's own, merged: packages and services unioned, personal commands first. */
export function resolveHostSpec(opts: { repoRoot?: string; home?: string; shell?: string }): ResolvedHostSpec {
  const home = opts.home ?? (process.env.HOME || os.homedir());
  const repo = opts.repoRoot ? parseManifest(path.join(opts.repoRoot, ".codecast", "workspace.toml"))?.host : undefined;
  const personalFile = path.join(home, PERSONAL_HOST_SPEC);
  const personal = fs.existsSync(personalFile) ? parseManifestText(fs.readFileSync(personalFile, "utf-8"), personalFile).host : undefined;
  const shellName = path.basename(opts.shell ?? process.env.SHELL ?? "bash");
  const shell = shellName === "zsh" || shellName === "fish" ? shellName : undefined;
  const uniq = (a: string[]) => [...new Set(a)];
  return {
    packages: uniq([...(personal?.packages ?? []), ...(repo?.packages ?? []), ...(shell ? [shell] : [])]),
    services: uniq([...(personal?.services ?? []), ...(repo?.services ?? [])]),
    run: [...(personal?.run ?? []), ...(repo?.run ?? [])],
    ...(shell ? { shell } : {}),
  };
}

export function hostSpecHash(spec: ResolvedHostSpec, repoPath: string | undefined): string {
  return createHash("sha256").update(JSON.stringify({ v: HOST_SETUP_VERSION, spec, repoPath: repoPath ?? null })).digest("hex").slice(0, 16);
}

/** The host tool directories every login shell gets; the tools step and installers put commands there. */
export const HOST_PATH_DIRS = [".local/bin", ".bun/bin", ".grok/bin", ".opencode/bin", ".fly/bin", ".cargo/bin"];

export function hostProfileScript(): string {
  return `# Written by codecast (cloud/hostSetup.ts) on every wake: every login shell on a cloud host.
export CODECAST_CLOUD=1
for d in ${HOST_PATH_DIRS.map((d) => `"$HOME/${d}"`).join(" ")}; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$d:$PATH" ;; esac
done
export PATH
`;
}

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

/**
 * The host-side script. Prints one JSON line: `{ ok, skipped? , applied?, step?, error? }`.
 * `force` re-applies a spec already in step.
 */
export function hostSetupScript(spec: ResolvedHostSpec, opts: { hash: string; repoPath?: string; force?: boolean }): string {
  const runs = spec.run.map((cmd, i) => `step "run[${i}]: ${cmd.replace(/[^A-Za-z0-9 ._/:=-]/g, "").slice(0, 60)}" bash -lc "$(printf '%s' ${b64(cmd)} | base64 -d)"`).join("\n");
  return `set -u
exec </dev/null
report() { python3 -c 'import json, sys; print(json.dumps(dict(ok=sys.argv[1] == "1", **({"skipped": sys.argv[2]} if sys.argv[2] else {}), **({"step": sys.argv[3], "error": sys.argv[4][-600:]} if sys.argv[3] else {}), applied=sys.argv[5] == "1")))' "$@"; }
# The login-shell base: always current, whatever the spec.
want_profile=$(printf '%s' ${b64(hostProfileScript())} | base64 -d)
if [ "$(cat /etc/profile.d/codecast-cloud.sh 2>/dev/null)" != "$want_profile" ]; then
  printf '%s\\n' "$want_profile" | sudo -n tee /etc/profile.d/codecast-cloud.sh >/dev/null 2>&1 || true
fi
stamp="$HOME/.codecast/host-setup.json"
have=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("hash", ""))' "$stamp" 2>/dev/null || true)
if [ "$have" = ${opts.hash} ] && [ ${opts.force ? 1 : 0} = 0 ]; then report 1 "in step" "" "" 0; exit 0; fi
log=$(mktemp)
step() { local name=$1; shift; if ! "$@" >>"$log" 2>&1; then report 0 "" "$name" "$(tail -c 600 "$log")" 0; rm -f "$log"; exit 0; fi; }
export DEBIAN_FRONTEND=noninteractive
missing=""
for p in ${spec.packages.join(" ")}; do dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then
  step "apt-get update" sudo -n apt-get update -qq
  step "install$missing" sudo -n apt-get install -y -qq $missing
fi
for s in ${spec.services.join(" ")}; do step "service $s" sudo -n systemctl enable --now "$s"; done
${spec.shell ? `sh_path=$(command -v ${spec.shell} || true); if [ -n "$sh_path" ] && [ "$(getent passwd "$USER" | cut -d: -f7)" != "$sh_path" ]; then step "login shell ${spec.shell}" sudo -n chsh -s "$sh_path" "$USER"; fi` : ""}
cd ${opts.repoPath ? `'${opts.repoPath.replace(/'/g, "'\\''")}' 2>/dev/null || cd "$HOME"` : '"$HOME"'}
${runs}
mkdir -p "$HOME/.codecast"
printf '{"hash":"%s","at":"%s"}\\n' ${opts.hash} "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stamp"
rm -f "$log"
report 1 "" "" "" 1
exit 0
`;
}

export interface HostSetupReport {
  ok: boolean;
  skipped?: string;
  applied?: boolean;
  step?: string;
  error?: string;
}

export function parseHostSetupOutput(out: string): HostSetupReport | null {
  const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) return null;
  try { return JSON.parse(line) as HostSetupReport; } catch { return null; }
}

/** Apply the declared setup on a host. Throws on transport failure; a failed step is a report. */
export function runHostSetup(host: RemoteHost, opts: { repoRoot?: string; repoPath?: string; force?: boolean; spec?: ResolvedHostSpec; timeoutMs?: number } = {}): { report: HostSetupReport; spec: ResolvedHostSpec } {
  const spec = opts.spec ?? resolveHostSpec({ repoRoot: opts.repoRoot });
  const repoPath = opts.repoPath;
  const script = hostSetupScript(spec, { hash: hostSpecHash(spec, repoPath), repoPath, force: opts.force });
  const r = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, 'bash -c "$(cat)" cast-host-setup'], {
    encoding: "utf-8", input: script, timeout: opts.timeoutMs ?? 30 * 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.error) throw new Error(`host setup on ${host.user}@${host.address} failed (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})`);
  const report = parseHostSetupOutput(r.stdout ?? "");
  if (!report) throw new Error(`host setup on ${host.user}@${host.address} returned no report (exit ${r.status}): ${(r.stderr ?? "").trim().split("\n").pop() ?? ""}`);
  return { report, spec };
}

export function describeHostSetup(report: HostSetupReport, spec: ResolvedHostSpec): string {
  if (!report.ok) return `host setup failed at ${report.step}: ${(report.error ?? "").trim().split("\n").slice(-2).join(" | ")}`;
  if (report.skipped) return `host setup in step`;
  const parts = [spec.packages.length && `${spec.packages.length} package(s)`, spec.services.length && `${spec.services.length} service(s)`, spec.run.length && `${spec.run.length} command(s)`, spec.shell && `${spec.shell} login shell`].filter(Boolean);
  return `host setup applied${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
