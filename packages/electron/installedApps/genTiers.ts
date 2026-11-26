// Writes tiers.json from the contract. The packaged desktop app runs plain JS
// and cannot import shared/contracts/pageApp.ts, so the engine reads a JSON
// copy; this script is the only writer of that copy.
//
//   permissions  APP_PERMISSIONS from pageApp.ts, in its order
//   methods      every cast.app method and the tier it needs: "default" or one
//                of the permissions. The method table is the engine's own API,
//                so it is kept here, beside the engine, and checked against the
//                permissions on every run.
//
// bun packages/electron/installedApps/genTiers.ts           rewrite tiers.json
// bun packages/electron/installedApps/genTiers.ts --check   exit 1 when it has drifted
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_PERMISSIONS } from "../../shared/contracts/pageApp";

const METHODS: Record<string, string> = {
  "app.info": "default",
  "app.badge": "default",
  "app.openInCodecast": "default",
  "permissions.request": "default",
  "window.setSize": "default",
  "window.setTitle": "default",
  "window.focus": "default",
  "window.minimize": "default",
  "window.close": "default",
  "app.notify": "notifications",
  "tray.set": "menu-bar",
  "tray.remove": "menu-bar",
  "shortcuts.register": "shortcuts",
  "shortcuts.unregister": "shortcuts",
  "window.setAlwaysOnTop": "overlay",
  "window.setVisibleOnAllWorkspaces": "overlay",
  "window.setIgnoreMouseEvents": "overlay",
  "agent.ask": "agent",
  "login.set": "login",
  "fs.readText": "full-access",
  "fs.writeText": "full-access",
  "fs.list": "full-access",
  "fs.stat": "full-access",
  "fs.remove": "full-access",
  "fs.watch": "full-access",
  "fs.unwatch": "full-access",
  "process.run": "full-access",
  "shell.open": "full-access",
};

export function tiersJson(): string {
  const permissions: readonly string[] = APP_PERMISSIONS;
  for (const [method, tier] of Object.entries(METHODS)) {
    if (tier !== "default" && !permissions.includes(tier)) throw new Error(`${method} needs "${tier}", which APP_PERMISSIONS does not have`);
  }
  return `${JSON.stringify({ permissions: [...permissions], methods: METHODS }, null, 2).replace(/\[\n\s+([^\]]*?)\n\s+\]/, (_m, inner: string) => `[${inner.split(/,\n\s+/).join(", ")}]`)}\n`;
}

if (import.meta.main) {
  const file = join(import.meta.dir, "tiers.json");
  const want = tiersJson();
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== want) {
      console.error("tiers.json is out of date: run bun packages/electron/installedApps/genTiers.ts");
      process.exit(1);
    }
  } else {
    writeFileSync(file, want);
  }
}
