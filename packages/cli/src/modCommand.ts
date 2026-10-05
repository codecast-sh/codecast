// `cast mod`: make, run and share codecast mods (plan pl-839). A mod is a
// folder with codecast-mod.json and a hooks module; `cast mod dev` bundles it
// with the SDK on every save and pushes it, and the web app picks the new
// bundle up live. Contract: shared/contracts/mods.ts. Build: mods/build.ts.

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";
import { buildMod, findModDir, MANIFEST_FILE, TYPES_FILE, authoringTypes, type ModBuild } from "./mods/build.js";
import { scaffoldFiles } from "./mods/scaffold.js";
import { MOD_NAME_RE } from "@codecast/shared/contracts/mods";
import { webBaseUrl } from "./config/readLocalConfig.js";
import { localHash, readApprovals, writeApproval } from "./mods/localRunner.js";

const cwd = () => process.env.CODECAST_CWD || process.cwd();

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function modUrl(name: string, pane?: string): string {
  return `${webBaseUrl().replace(/\/$/, "")}/m/${name}${pane ? `/${pane}` : ""}`;
}

function reportBuild(build: ModBuild, quiet = false): build is Extract<ModBuild, { ok: true }> {
  if (!build.ok) {
    console.error(`Build failed (${build.dir}):`);
    for (const e of build.errors) console.error(`  ${e}`);
    return false;
  }
  for (const w of build.warnings) console.error(`warning: ${w}`);
  if (!quiet) {
    const i = build.inspection;
    console.log(`  hooks: ${i.hooks.join(", ") || "none"}`);
    console.log(`  calls: ${i.calls.map((c) => `$.${c}`).join(", ") || "none"}`);
    if (i.reads.length) console.log(`  reads: ${i.reads.join(", ")}`);
  }
  return true;
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function push(deps: PublishDeps, build: Extract<ModBuild, { ok: true }>, opts: { publish?: boolean; note?: string; scope?: Record<string, unknown>; shared?: boolean } = {}) {
  return await apiPost(deps, "/cli/mods/push", {
    manifest: build.manifest,
    code: build.code,
    local_code: build.local?.code,
    local_hash: build.local?.hash,
    source: opts.publish ? build.source : undefined,
    publish: opts.publish ?? false,
    note: opts.note,
    ...(opts.scope ?? {}),
    ...(opts.shared !== undefined ? { shared: opts.shared } : {}),
  });
}

async function printLogs(deps: PublishDeps, name: string, since: number, limit = 100): Promise<number> {
  const res = await apiPost(deps, "/cli/mods/logs", { name, since, limit }, { read: true });
  let last = since;
  for (const l of res.logs ?? []) {
    const tag = l.level === "error" ? "ERROR" : l.level === "warn" ? "warn " : "log  ";
    console.log(`${fmtTime(l.at)} ${tag} ${l.text}`);
    last = Math.max(last, l.at);
  }
  return last;
}

async function teamScope(deps: PublishDeps, team: string | undefined) {
  if (!team) return {};
  const { scopeFor } = await import("./signalCommand.js");
  const scope: Record<string, unknown> = (await scopeFor(deps, team, true)) ?? {};
  return scope.team_id ? { team_id: scope.team_id } : {};
}

export function registerModCommand(program: Command, deps: PublishDeps): void {
  const mod = program.command("mod").alias("mods").description(commandGroup("mod").description);

  mod
    .command("new <name>")
    .description("Scaffold a mod that already works: a pane, a command and a fence")
    .option("--dir <path>", "Where to create it (default: ./<name>)")
    .action(async (name: string, options: { dir?: string }) => {
      if (!MOD_NAME_RE.test(name)) fail("a mod name is 2 to 40 characters of a-z, 0-9 and -, starting with a letter");
      const dir = path.resolve(cwd(), options.dir ?? name);
      if (fs.existsSync(path.join(dir, MANIFEST_FILE))) fail(`${dir} already holds a mod`);
      fs.mkdirSync(dir, { recursive: true });
      for (const [file, text] of Object.entries(scaffoldFiles(name))) fs.writeFileSync(path.join(dir, file), text);
      console.log(`Created ${path.relative(cwd(), dir) || "."}/`);
      for (const file of Object.keys(scaffoldFiles(name))) console.log(`  ${file}`);
      console.log(`\nNext: cd ${path.relative(cwd(), dir) || "."} && cast mod dev   (pushes on every save; opens at ${modUrl(name, "main")})`);
    });

  mod
    .command("build [dir]")
    .description("Bundle the mod and check it against its manifest, without pushing")
    .option("--json", "The inspection as JSON")
    .action(async (dir: string | undefined, options: { json?: boolean }) => {
      const build = await buildMod(dir ?? cwd());
      if (options.json) {
        console.log(JSON.stringify(build.ok ? { ok: true, name: build.manifest.name, bytes: build.code.length, inspection: build.inspection, warnings: build.warnings } : build, null, 2));
        if (!build.ok) process.exit(1);
        return;
      }
      if (!reportBuild(build)) process.exit(1);
      console.log(`ok ${build.manifest.name}: ${Math.round(build.code.length / 100) / 10} KB`);
    });

  mod
    .command("inspect [dir]")
    .description("What the mod hooks, which $ methods it calls, what it reads, and what its manifest grants")
    .option("--json", "As JSON")
    .action(async (dir: string | undefined, options: { json?: boolean }) => {
      const build = await buildMod(dir ?? cwd());
      if (!build.ok) { reportBuild(build); process.exit(1); }
      const p = build.manifest.permissions ?? {};
      const out = {
        name: build.manifest.name,
        ...build.inspection,
        grants: { read: p.read ?? [], write: p.write ?? [], fetch: p.fetch ?? [] },
        contributes: { panes: build.manifest.panes ?? [], commands: build.manifest.commands ?? [], fences: build.manifest.fences ?? [] },
      };
      if (options.json) return console.log(JSON.stringify(out, null, 2));
      console.log(`${out.name}`);
      console.log(`  hooks:    ${out.hooks.join(", ") || "none"}`);
      console.log(`  calls:    ${out.calls.map((c) => `$.${c}`).join(", ") || "none"}`);
      console.log(`  reads:    ${out.reads.join(", ") || "none"}`);
      console.log(`  grants:   read ${JSON.stringify(out.grants.read)}, write ${JSON.stringify(out.grants.write)}, fetch ${JSON.stringify(out.grants.fetch)}`);
      console.log(`  panes:    ${out.contributes.panes.map((x) => x.id).join(", ") || "none"}`);
      console.log(`  commands: ${out.contributes.commands.map((x) => x.id).join(", ") || "none"}`);
      console.log(`  fences:   ${out.contributes.fences.map((x) => x.lang).join(", ") || "none"}`);
      for (const w of build.warnings) console.log(`  warning:  ${w}`);
    });

  mod
    .command("push [dir]")
    .description("Build and push once, as a dev build: the open app reloads it")
    .action(async (dir: string | undefined) => {
      const build = await buildMod(dir ?? cwd());
      if (!reportBuild(build, true)) process.exit(1);
      const res = await push(deps, build);
      console.log(`ok ${res.name} rev ${res.rev}${res.created ? " (new)" : ""}: ${modUrl(res.name, build.manifest.panes?.[0]?.id)}`);
      console.log(`   cast mod logs ${res.name}   shows what it printed and threw`);
    });

  mod
    .command("dev [dir]")
    .description("Push on every save and print the mod's logs as they arrive (Ctrl-C to stop)")
    .action(async (dir: string | undefined) => {
      const root = findModDir(dir ?? cwd());
      if (!root) fail(`no ${MANIFEST_FILE} here or above (cast mod new <name>)`);
      let name = "";
      let since = Date.now();
      let running = false;
      let again = false;
      const cycle = async () => {
        if (running) { again = true; return; }
        running = true;
        try {
          const build = await buildMod(root);
          if (reportBuild(build, true)) {
            const res = await push(deps, build).catch((err: Error) => { console.error(`push failed: ${err.message}`); return null; });
            if (res) {
              name = res.name;
              console.log(`${fmtTime(Date.now())} pushed rev ${res.rev}: ${modUrl(res.name, build.manifest.panes?.[0]?.id)}`);
            }
          }
        } finally {
          running = false;
          if (again) { again = false; void cycle(); }
        }
      };
      await cycle();
      let timer: ReturnType<typeof setTimeout> | null = null;
      fs.watch(root, { recursive: true }, (_event, file) => {
        if (!file || /node_modules|\.git|codecast-mod\.d\.ts/.test(String(file))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void cycle(), 250);
      });
      console.log(`watching ${root}`);
      setInterval(async () => {
        if (!name) return;
        try { since = await printLogs(deps, name, since); } catch {}
      }, 2000);
      await new Promise(() => {});
    });

  mod
    .command("publish [dir]")
    .description("Push a numbered version with its source: readable, diffable and restorable")
    .option("-m, --note <text>", "What changed")
    .option("--team <name|id>", "The team the mod belongs to")
    .option("--share", "Share it with that team: teammates see it on their mods page")
    .option("--private", "Stop sharing it")
    .action(async (dir: string | undefined, options: { note?: string; team?: string; share?: boolean; private?: boolean }) => {
      const build = await buildMod(dir ?? cwd());
      if (!reportBuild(build, true)) process.exit(1);
      if (options.share && !options.team) fail("--share needs --team <name>");
      const scope = await teamScope(deps, options.team);
      const res = await push(deps, build, { publish: true, note: options.note, scope, shared: options.share ? true : options.private ? false : undefined });
      console.log(`ok ${res.name} v${res.version} (rev ${res.rev})${options.share ? ", shared with the team" : ""}: ${modUrl(res.name)}`);
    });

  mod
    .command("ls")
    .description("Your mods: version, state and the last thing each one logged")
    .option("--json", "As JSON")
    .action(async (options: { json?: boolean }) => {
      const res = await apiPost(deps, "/cli/mods/list", {}, { read: true });
      if (options.json) return console.log(JSON.stringify(res.mods, null, 2));
      if (!res.mods?.length) return console.log("No mods yet. cast mod new <name> makes one.");
      for (const m of res.mods) {
        const state = m.enabled ? "on " : "off";
        const ver = m.version ? `v${m.version}` : "dev";
        console.log(`${state} ${m.name.padEnd(24)} ${ver.padEnd(5)} rev ${String(m.rev).padEnd(4)} ${m.shared ? "shared " : ""}${m.title ?? ""}`);
        if (m.last_log?.level === "error") console.log(`    last error ${fmtTime(m.last_log.at)}: ${m.last_log.text.split("\n")[0].slice(0, 120)}`);
      }
    });

  mod
    .command("logs <name>")
    .description("What the running mod printed and threw, newest last")
    .option("-f, --follow", "Keep printing as lines arrive")
    .option("-n, --lines <n>", "How many recent lines", "50")
    .action(async (name: string, options: { follow?: boolean; lines?: string }) => {
      let since = await printLogs(deps, name, 0, Number(options.lines) || 50);
      if (!options.follow) return;
      setInterval(async () => { try { since = await printLogs(deps, name, since); } catch {} }, 2000);
      await new Promise(() => {});
    });

  mod
    .command("versions <name>")
    .description("Published versions of a mod")
    .action(async (name: string) => {
      const res = await apiPost(deps, "/cli/mods/versions", { name }, { read: true });
      if (!res.versions.length) return console.log(`${name} has no published versions (rev ${res.rev}, dev only). cast mod publish makes one.`);
      for (const v of res.versions) console.log(`v${v.version}${v.version === res.current ? "*" : " "} ${new Date(v.at).toISOString().slice(0, 16).replace("T", " ")}  ${v.files} files  ${v.note ?? ""}`);
    });

  mod
    .command("pull <name>")
    .description("Write a published version's source into a folder, to read or fork it")
    .option("--version <n>", "Which version (default: the latest)")
    .option("--dir <path>", "Where (default: ./<name>)")
    .action(async (name: string, options: { version?: string; dir?: string }) => {
      const res = await apiPost(deps, "/cli/mods/get-version", { name, ...(options.version ? { version: Number(options.version) } : {}) }, { read: true });
      const dir = path.resolve(cwd(), options.dir ?? name);
      for (const [rel, text] of Object.entries(res.source as Record<string, string>)) {
        const file = path.join(dir, rel);
        if (!file.startsWith(dir + path.sep)) continue;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
      fs.writeFileSync(path.join(dir, TYPES_FILE), authoringTypes());
      console.log(`ok v${res.version} of ${name} -> ${path.relative(cwd(), dir) || "."}/ (${Object.keys(res.source).length} files)`);
    });

  mod
    .command("rollback <name> <version>")
    .description("Run a published version again")
    .action(async (name: string, version: string) => {
      const res = await apiPost(deps, "/cli/mods/rollback", { name, version: Number(version) });
      console.log(`ok ${name} runs v${res.version} again (rev ${res.rev})`);
    });

  for (const [verb, enabled] of [["enable", true], ["disable", false]] as const) {
    mod
      .command(`${verb} <name>`)
      .description(enabled ? "Turn a mod on" : "Turn a mod off without removing it")
      .action(async (name: string) => {
        await apiPost(deps, "/cli/mods/set-enabled", { name, enabled });
        console.log(`ok ${name} ${enabled ? "on" : "off"}`);
      });
  }

  mod
    .command("rm <name>")
    .description("Delete a mod with its versions and logs")
    .option("--yes", "Confirm")
    .action(async (name: string, options: { yes?: boolean }) => {
      if (!options.yes) fail(`this deletes ${name}, its versions and its logs; pass --yes`);
      // A removal with many versions finishes in several passes (each under Convex's read cap).
      for (let i = 0; i < 50; i++) {
        const res = await apiPost(deps, "/cli/mods/remove", { name });
        if (!res.more) break;
      }
      console.log(`ok removed ${name}`);
    });

  mod
    .command("open <name> [pane]")
    .description("Print the link to a mod's pane, its first pane by default (pass it to cast browser open to see it)")
    .action(async (name: string, pane: string | undefined) => {
      if (!pane) {
        const res = await apiPost(deps, "/cli/mods/list", {}, { read: true });
        pane = res.mods?.find((m: any) => m.name === name)?.manifest?.panes?.[0]?.id;
      }
      console.log(modUrl(name, pane));
    });

  mod
    .command("guide")
    .description("What the mods running for you ask of agents: the blocks they draw and the objects they track")
    .option("--json", "As JSON")
    .action(async (options: { json?: boolean }) => {
      const res = await apiPost(deps, "/cli/mods/guide", {}, { read: true });
      if (options.json) return console.log(JSON.stringify(res.mods, null, 2));
      if (!res.mods?.length) return console.log("No mods are running for you.");
      for (const m of res.mods) {
        console.log(`## ${m.title ?? m.name}${m.mine ? "" : " (shared by your team)"}`);
        if (m.description) console.log(m.description);
        if (m.agents) console.log(`\n${m.agents}`);
        for (const f of m.fences) console.log(`- \`\`\`${f.lang} blocks draw through it${f.description ? `: ${f.description}` : ""}`);
        for (const k of m.objects) {
          console.log(`- ${k.title} objects (${k.prefix}-N): cast obj create ${k.prefix} "<title>"${k.fields.length ? " [--set <field>=<value>]" : ""}`);
          if (k.fields.length) console.log(`  fields: ${k.fields.join(", ")}${k.statuses?.length ? `; statuses: ${k.statuses.join(" -> ")}` : ""}  (cast obj kinds has their types)`);
        }
        console.log("");
      }
    });

  mod
    .command("approve <name>")
    .description("Let this machine run a mod's local half, at its current version (a person, in a terminal)")
    .action(async (name: string) => {
      const res = await apiPost(deps, "/cli/mods/local", {}, { read: true });
      const m = (res.mods ?? []).find((x: any) => x.name === name);
      if (!m) fail(`${name} has no local half (its manifest names one under "local")`);
      const code: string = m.local_code;
      const hash = localHash(code);
      const uses = [
        ...new Set([...code.matchAll(/from\s*["'](node:[a-z_/]+|bun:[a-z_]+|[a-z][\w-]*)["']/g)].map((x) => x[1])),
      ].filter((x) => !x.startsWith("codecast-mod"));
      const reaches = [
        /Bun\.spawn|child_process|\.sh\(|\.cast\(/.test(code) && "runs processes",
        /\bfetch\(/.test(code) && "makes network requests",
        /node:fs|Bun\.file|Bun\.write/.test(code) && "reads or writes files",
        /process\.env/.test(code) && "reads environment variables",
      ].filter(Boolean);
      console.log(`${m.title ?? name}: the local half ${hash} (${Math.round(code.length / 100) / 10} KB), rev ${m.rev}`);
      if (m.manifest?.local?.description) console.log(`  ${m.manifest.local.description}`);
      console.log(`  runs on this machine with your access. A quick scan of the bundle (not a review; read the code) finds: ${reaches.length ? reaches.join(", ") : "no process, network, file or env use"}`);
      if (uses.length) console.log(`  imports: ${uses.join(", ")}`);
      console.log(`  read it: cast mod pull ${name}  (after a publish), or the bundle in the mod's folder`);
      const approved = readApprovals()[name];
      if (approved?.hash === hash) return console.log(`Already approved here. It runs within 30s while the mod is on.`);
      if (!process.stdin.isTTY) {
        fail(`approving runs this code on this machine with your access, so a person approves it in a terminal. Ask them to run: ! cast mod approve ${name}`);
      }
      process.stdout.write(`Type ${name} to approve it here: `);
      const answer = await new Promise<string>((resolve) => process.stdin.once("data", (d) => resolve(String(d).trim())));
      process.stdin.pause();
      if (answer !== name) fail("not approved");
      writeApproval(name, hash);
      console.log(`ok approved ${name} (${hash}) on this machine; the daemon starts it within 30s. cast mod revoke ${name} stops it.`);
    });

  mod
    .command("call <name> <method> [args]")
    .description("Call a mod's local half the way its UI does ($.local.call), and print the answer")
    .option("--timeout <s>", "How long to wait for a machine to answer", "120")
    .action(async (name: string, method: string, argsJson: string | undefined, options: { timeout?: string }) => {
      let args: unknown = null;
      if (argsJson) { try { args = JSON.parse(argsJson); } catch { fail("args must be JSON, e.g. '{\"repo\":\"codecast\"}'"); } }
      const { id } = await apiPost(deps, "/cli/mods/call", { name, method, args });
      const until = Date.now() + (Number(options.timeout) || 120) * 1000;
      while (Date.now() < until) {
        const call = await apiPost(deps, "/cli/mods/get-call", { id }, { read: true });
        if (call.status === "done") { console.log(typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2)); console.error(`(answered by ${call.device_name ?? "?"})`); return; }
        if (call.status === "failed") fail(`${call.error}${call.device_name ? ` (on ${call.device_name})` : ""}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      fail("no machine running its local half answered (cast mod local shows where it runs)");
    });

  mod
    .command("revoke <name>")
    .description("Stop running a mod's local half on this machine")
    .action(async (name: string) => {
      writeApproval(name, null);
      console.log(`ok ${name} no longer runs here; the daemon stops it within 30s`);
    });

  mod
    .command("local")
    .description("The local halves your mods have, and which this machine runs")
    .action(async () => {
      const res = await apiPost(deps, "/cli/mods/local", {}, { read: true });
      const approvals = readApprovals();
      if (!res.mods?.length) return console.log(`None of your mods has a local half.`);
      for (const m of res.mods) {
        const a = approvals[m.name];
        const hash = localHash(m.local_code);
        const state = !m.enabled ? "off" : a?.hash === hash ? "runs here" : a ? "new version waits: cast mod approve" : "not approved here";
        console.log(`${m.name.padEnd(24)} ${hash}  ${state}`);
      }
    });

  mod
    .command("types [dir]")
    .description(`Rewrite ${TYPES_FILE} with this build's API`)
    .action(async (dir: string | undefined) => {
      const root = findModDir(dir ?? cwd());
      if (!root) fail(`no ${MANIFEST_FILE} here or above`);
      fs.writeFileSync(path.join(root, TYPES_FILE), authoringTypes());
      console.log(`ok ${path.join(root, TYPES_FILE)}`);
    });
}
