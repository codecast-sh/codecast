/**
 * `cast dev`: start (or reuse) this checkout's dev servers and print where
 * they answer. The engine is workspace/dev.ts; this is its argv and output.
 */

import * as fs from "node:fs";
import type { Command } from "commander";
import { spawn } from "../proc.js";
import { fmt, icons } from "../colors.js";
import { commandGroup } from "../commandGroups.js";
import { resolveManifest } from "./resolver.js";
import {
  checkoutRoot, devServices, ensureService, readRecord, serviceStatus, stopService,
  type DevService, type DevStatus,
} from "./dev.js";

function loadServices(names: string[]): { checkout: string; manifest: ReturnType<typeof resolveManifest>; services: DevService[] } {
  const checkout = checkoutRoot();
  const manifest = resolveManifest(checkout);
  const all = devServices(manifest);
  if (all.length === 0) {
    console.error(`${fmt.error(icons.cross)} this project declares no dev server and none was detected`);
    console.error(fmt.muted(`  declare one in .codecast/workspace.toml:`));
    console.error(fmt.muted(`    [services.web]\n    mode = "isolated"\n    start = "bun run dev --port $PORT_WEB"\n    port = "web"`));
    process.exit(1);
  }
  const unknown = names.filter((n) => !all.some((s) => s.name === n));
  if (unknown.length) {
    console.error(`${fmt.error(icons.cross)} no service named ${unknown.join(", ")} (have: ${all.map((s) => s.name).join(", ")})`);
    process.exit(1);
  }
  return { checkout, manifest, services: names.length ? all.filter((s) => names.includes(s.name)) : all };
}

function printStatus(s: DevStatus): void {
  const name = s.name.padEnd(8);
  switch (s.state) {
    case "started":
    case "running":
      console.log(`${fmt.success(icons.check)} ${name} ${fmt.highlight(s.record.url)}  ${fmt.muted(`${s.state === "started" ? "started" : "already running"}, pid ${s.record.pid}`)}`);
      break;
    case "external":
      console.log(`${fmt.success(icons.check)} ${name} ${fmt.highlight(s.url)}  ${fmt.muted("already answering on this checkout's port (not started by cast dev)")}`);
      break;
    case "shared":
      console.log(`${fmt.success(icons.check)} ${name} ${fmt.highlight(s.url)}  ${fmt.muted("shared")}`);
      break;
    case "stopped":
      console.log(`${fmt.muted("-")} ${name} ${fmt.muted("stopped")}`);
      break;
    case "failed":
      console.log(`${fmt.error(icons.cross)} ${name} ${s.reason}`);
      if (s.record) console.log(fmt.muted(`  command: ${s.record.command}\n  log: ${s.record.log}`));
      if (s.logTail) console.log(s.logTail.split("\n").map((l) => fmt.muted(`  | ${l}`)).join("\n"));
      break;
  }
}

export function registerDevCommand(program: Command): void {
  const dev = program
    .command("dev")
    .argument("[service...]", "Services to start (default: all)")
    .description(commandGroup("dev").description)
    .option("--timeout <sec>", "Seconds to wait for each server to answer")
    .option("--json", "Output JSON")
    .action(async (names: string[], o: { timeout?: string; json?: boolean }) => {
      const { checkout, manifest, services } = loadServices(names);
      const results: DevStatus[] = [];
      for (const svc of services) {
        const status = await ensureService(svc, {
          checkout, manifest,
          timeoutSec: o.timeout ? Number(o.timeout) : undefined,
          onWait: o.json ? undefined : (s, sec) => console.log(fmt.muted(`  ${s.name}: waiting for it to answer (${sec}s)`)),
        });
        results.push(status);
        if (!o.json) printStatus(status);
      }
      if (o.json) console.log(JSON.stringify(results, null, 2));
      else if (results.some((r) => r.state === "started" || r.state === "running")) {
        console.log(fmt.muted(`  open it with cast browser open <url> (signed out? cast browser sync <url>); show your human with cast preview <url>`));
      }
      if (results.some((r) => r.state === "failed")) process.exit(1);
    });

  dev.command("status")
    .argument("[service...]")
    .description("Show which dev servers run in this checkout, without starting any")
    .option("--json", "Output JSON")
    .action(async (names: string[], o: { json?: boolean }) => {
      const { checkout, manifest, services } = loadServices(names);
      const results = await Promise.all(services.map((s) => serviceStatus(s, checkout, manifest)));
      if (o.json) console.log(JSON.stringify(results, null, 2));
      else results.forEach(printStatus);
    });

  dev.command("stop")
    .argument("[service...]")
    .description("Stop dev servers cast dev started in this checkout")
    .action(async (names: string[]) => {
      const { checkout, services } = loadServices(names);
      for (const svc of services) {
        const stopped = await stopService(svc, checkout);
        console.log(stopped ? `${fmt.success(icons.check)} ${svc.name} stopped` : fmt.muted(`- ${svc.name} was not running`));
      }
    });

  dev.command("logs")
    .argument("[service]")
    .description("Print a dev server's output")
    .option("-n, --lines <n>", "Lines from the end", "80")
    .option("-f, --follow", "Keep printing as it writes")
    .action((name: string | undefined, o: { lines: string; follow?: boolean }) => {
      const { checkout, services } = loadServices(name ? [name] : []);
      const record = readRecord(checkout, services[0].name);
      if (!record || !fs.existsSync(record.log)) {
        console.error(`${fmt.error(icons.cross)} ${services[0].name} has no log here; start it with cast dev`);
        process.exit(1);
      }
      const child = spawn("tail", ["-n", o.lines, ...(o.follow ? ["-f"] : []), record.log], { stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
