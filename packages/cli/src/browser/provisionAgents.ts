/**
 * The "agent CLIs" step of `cast hosts provision`: install claude, codex,
 * gemini, grok, opencode and pi on the box at the laptop's versions when missing, plus a
 * user-local Node that shadows apt's node 18 through /usr/local/bin without
 * replacing the distro package novnc depends on.
 *
 * How the host got what it has, verified: codex is ~/.bun/bin/codex →
 * @openai/codex/bin/codex.js with `#!/usr/bin/env node`, so it runs under
 * whichever `node` PATH finds (apt 18 at /usr/bin today); claude is the
 * native installer at ~/.local/bin; the daemon's PATH is
 * /usr/local/bin:/usr/bin:/bin:~/.local/bin, so a /usr/local/bin/node
 * symlink shadows /usr/bin/node for every agent launch. The snippets are the
 * same ones cloud/hostTools.ts runs on every wake.
 */

import { INSTALLABLE_CLIENTS, type InstallableClient } from "../remote/agentAuth.js";
import { clientInstallSnippet, HOST_TOOLS_PATH, NODE_FLOOR_MAJOR, nodeInstallSnippet, safeVersion } from "../cloud/hostTools.js";
export { NODE_22_VERSION } from "../cloud/hostTools.js";

/**
 * Idempotent bash: node guard, then `command -v` guarded installs, then a
 * /usr/local/bin symlink for each binary found, then one `<bin>=<version|
 * missing>` line per client, `node=<v>` and `AGENT-CLIS-OK`. A version that
 * is not x.y.z is not interpolated (the install runs unpinned). The report
 * loop runs under `set -e`, so a CLI whose `--version` fails (gemini on an
 * old node) reports empty instead of aborting the step after the installs.
 */
export function codexCompatibilityScript(version: string | undefined): string {
  const wanted = safeVersion(version);
  if (!wanted) return "";
  return `codex_compatible() {
  current=$(codex --version 2>/dev/null || true)
  python3 -c 'import re,sys; m=re.search(r"[0-9]+\\.[0-9]+\\.[0-9]+",sys.argv[1]); sys.exit(0 if m and tuple(map(int,m[0].split("."))) >= tuple(map(int,sys.argv[2].split("."))) else 1)' "$current" '${wanted}'
}
if ! codex_compatible; then
  echo 'Updating Codex to support the laptop configuration…'
  bun install -g @openai/codex@${wanted}
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.bun/bin/codex" "$HOME/.local/bin/codex"
  hash -r
  codex_compatible || { echo 'Codex is still older than the laptop; setup cannot continue' >&2; exit 1; }
fi`;
}

export function agentCliInstallScript(versions: Partial<Record<InstallableClient, string>>, opts: { upgradeCodex?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`set -euo pipefail
${HOST_TOOLS_PATH}
node_installed=0; node_err=""
${nodeInstallSnippet(NODE_FLOOR_MAJOR)}`);
  for (const client of INSTALLABLE_CLIENTS) {
    lines.push(`${clientInstallSnippet(client, versions[client])} || true`);
  }
  if (opts.upgradeCodex) lines.push(codexCompatibilityScript(versions.codex));
  lines.push(`for b in ${INSTALLABLE_CLIENTS.join(" ")}; do
  p=$(command -v "$b" 2>/dev/null || true)
  if [ -n "$p" ] && [ "$(uname -s)" = Linux ] && sudo -n true >/dev/null 2>&1; then sudo -n ln -sf "$p" "/usr/local/bin/$b" >/dev/null 2>&1 || true; fi
done
for b in ${INSTALLABLE_CLIENTS.join(" ")}; do
  if command -v "$b" >/dev/null 2>&1; then v=$("$b" --version 2>/dev/null </dev/null | head -1 | tr -cd 'A-Za-z0-9._ ()-' | head -c 60 || true); echo "$b=$v"; else echo "$b=missing"; fi
done
if command -v node >/dev/null 2>&1; then nv=$(node -v 2>/dev/null || true); else nv=missing; fi
echo "node=$nv$([ -n "$node_err" ] && echo " ($node_err)" || true)"
echo AGENT-CLIS-OK`);
  return lines.join("\n");
}

/** The `<bin>=<version>` lines of the script's output as one report line. */
export function parseAgentCliReport(out: string): string {
  const names = new Set<string>([...INSTALLABLE_CLIENTS, "node"]);
  const pairs = out.split("\n").map((l) => l.trim()).filter((l) => names.has(l.split("=")[0]) && l.includes("="));
  return pairs.join("  ");
}
