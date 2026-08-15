// `cast cap on|off <slug> [--project|--session <id>]` — the CLI equip control.
//
// The same three plain choices the web offers: everywhere (user scope), this
// project (the repo the command runs in, keyed by git origin), this session.
// Team and device scope exist for admins and ops and are reachable via
// --scope, but the ordinary path is one flag or none.
//
// Every write goes to /cli/cap/bind, which is the SAME upsert the web's
// setCapabilityBinding dispatch side effect calls — one code path decides the
// upsert key, so a toggle here and a toggle in the browser land on one row.

import type { Command } from "commander";
import { execSync } from "child_process";
import { buildProjectScopeKey, requiresExplicitConsent } from "@codecast/shared/contracts";
import { apiPost, type PublishDeps } from "../publish.js";
import { deviceId } from "../remote/device.js";

interface EquipOpts {
  project?: boolean;
  session?: string;
  scope?: string;
  yes?: boolean;
  json?: boolean;
}

/** The repo identity of the current directory, or a local: key when it has
 *  no origin. Never a bare path — the resolver contract forbids it. */
export function currentProjectScopeKey(userId: string, cwd = process.cwd()): string | null {
  let origin: string | undefined;
  try {
    origin = execSync("git config --get remote.origin.url", { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    origin = undefined;
  }
  let root = cwd;
  try {
    root = execSync("git rev-parse --show-toplevel", { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    // not a git repo: local key on the cwd
  }
  return buildProjectScopeKey({ originUrl: origin || undefined, path: root, userId });
}

function resolveScope(opts: EquipOpts, userId: string): { scope_kind: string; scope_key: string } | { error: string } {
  if (opts.scope) {
    const [kind, ...rest] = opts.scope.split(":");
    return { scope_kind: kind!, scope_key: rest.join(":") };
  }
  if (opts.session) return { scope_kind: "session", scope_key: opts.session };
  if (opts.project) {
    const key = currentProjectScopeKey(userId);
    if (!key) return { error: "cannot key this directory as a project — is it a git checkout?" };
    return { scope_kind: "project", scope_key: key };
  }
  return { scope_kind: "user", scope_key: "" };
}

async function equip(deps: PublishDeps, slug: string, enabled: boolean, opts: EquipOpts): Promise<void> {
  const me = await apiPost(deps, "/cli/whoami", {}, { read: true, exitOnError: false }).catch(() => null);
  const userId = me?.user_id ?? me?._id ?? "me";
  const scope = resolveScope(opts, userId);
  if ("error" in scope) {
    console.error(scope.error);
    process.exit(1);
  }

  // The consent rule, CLI half: --yes may skip the prompt ONLY for prose. The
  // server enforces the same rule on the materializing device (a bound
  // capability with code surfaces holds until a consent row exists), so this is
  // the honest early answer, not the only gate.
  if (enabled && !opts.yes && process.stdin.isTTY) {
    const surfaces = await apiPost(deps, "/cli/cap/surfaces", { slug }, { read: true, exitOnError: false }).catch(() => null);
    if (surfaces?.surfaces && requiresExplicitConsent(surfaces.surfaces)) {
      console.log(`${slug} runs code (${surfaces.surfaces.join(", ")}). Turning it on means consenting to that on every machine the scope covers.`);
      console.log(`Re-run with --yes to confirm, or turn it on from the web where the consent sheet shows the manifest.`);
      process.exit(2);
    }
  }

  const res = await apiPost(deps, "/cli/cap/bind", {
    capability_slug: slug,
    scope_kind: scope.scope_kind,
    scope_key: scope.scope_key,
    enabled,
    device_id: deviceId(),
  });
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  const where =
    scope.scope_kind === "user" ? "everywhere"
    : scope.scope_kind === "project" ? `in ${scope.scope_key.replace(/^git:/, "").replace(/^local:[^:]+:/, "")}`
    : scope.scope_kind === "session" ? "this session"
    : `${scope.scope_kind} ${scope.scope_key}`;
  if (res?.status === "rejected") {
    console.error(`Refused: ${res.reason}`);
    process.exit(1);
  }
  console.log(`${slug} ${enabled ? "on" : "off"} ${where}. Machines pick it up on their next heartbeat.`);
}

export function registerCapEquip(cap: Command, deps: PublishDeps): void {
  const common = (c: Command) =>
    c
      .option("--project", "Only in the repo this command runs in")
      .option("--session <id>", "Only in one session")
      .option("--scope <kind:key>", "Any scope explicitly (team:<id>, device:<id>, …)")
      .option("-y, --yes", "Skip the consent prompt (only honored for prose capabilities)")
      .option("--json", "Machine-readable output");

  common(cap.command("on <slug>").description("Turn a capability on — everywhere, in this project, or in one session"))
    .action((slug: string, opts: EquipOpts) => equip(deps, slug, true, opts));
  common(cap.command("off <slug>").description("Turn a capability off at a scope (a real disable, never a delete)"))
    .action((slug: string, opts: EquipOpts) => equip(deps, slug, false, opts));

  cap
    .command("mode <mode>")
    .description("Reconciler mode for your machines: off (report only), dry (plan, never write), on")
    .action(async (mode: string) => {
      if (!["off", "dry", "on"].includes(mode)) {
        console.error("mode must be off, dry or on");
        process.exit(1);
      }
      const res = await apiPost(deps, "/cli/cap/mode", { mode });
      console.log(`capabilities mode: ${res.mode}. Machines pick it up on their next heartbeat.`);
    });

  cap
    .command("bindings")
    .description("Every place you have said on or off")
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const rows: any[] = await apiPost(deps, "/cli/cap/bindings", {}, { read: true });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No bindings yet. `cast cap on <slug>` turns something on everywhere; add --project for just this repo.");
        return;
      }
      for (const r of rows) {
        const where = r.scope_kind === "user" ? "everywhere" : `${r.scope_kind} ${r.scope_key}`;
        console.log(`${r.enabled ? "on " : "off"}  ${r.capability_slug}  ${where}`);
      }
    });
}
