// The two macOS grants that let an agent drive other apps on this Mac —
// Accessibility and Screen Recording — read and opened through the cast CLI.
//
// They do not belong to Codecast. macOS keys a TCC grant to a code signature
// and a path together, so the grant is asked for by one small signed app with
// a fixed identity, `codecast computer` (sh.codecast.computer), and survives
// every Codecast release. The desktop app's job is only to show the human what
// that app is granted and to open the right System Settings pane when they ask.
//
// Nothing here calls an accessibility or a screen API. If the shell asked,
// macOS would record the answer against the shell, and the desktop app would
// hold a grant it has no business holding. Every read runs
// `cast computer permissions --json`, which launches the helper as its own
// responsible process so the helper answers about itself; the one gesture runs
// `cast computer permissions --open-settings`, which is the helper's own
// window and the only thing in this file that may take the screen.
//
// The readiness vocabulary is the shared one (lib/osPermissions.ts):
//   granted — codecast computer has it
//   off     — it does not; System Settings is the only way in, so the row
//             offers that button whether the grant was denied or never asked
//   n/a     — no such grant here (not macOS)
//   unknown — could not tell (no CLI on this machine, a CLI too old to have
//             the verb, a read that failed): never nag on unknown

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const COMPUTER_KINDS = ["computerAccessibility", "computerScreen"];

// The kind the renderer names → the grant the CLI names.
const PERMISSION_ID = {
  computerAccessibility: "accessibility",
  computerScreen: "screenshots",
};

// One read launches the helper and waits on tccd, which the CLI budgets 30
// seconds for. Anything under that would report a timeout where the CLI was
// about to answer.
const READ_TIMEOUT_MS = 45_000;

// Where `cast` installs itself. The shell is launched from Finder, whose PATH
// is /usr/bin:/bin:/usr/sbin:/sbin, so the install directories are checked by
// name first and the bare command is the last resort.
const CLI_CANDIDATES = ["/opt/homebrew/bin/cast", "/usr/local/bin/cast"];
const CLI_HOME_CANDIDATES = [".local/bin/cast", ".codecast/bin/cast"];

// CODECAST_CLI names an executable that behaves like `cast`. It exists for a
// desktop run from source, where the CLI is a bun entry rather than a binary.
function resolveCli({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.CODECAST_CLI) return env.CODECAST_CLI;
  for (const rel of CLI_HOME_CANDIDATES) {
    const candidate = path.join(home, rel);
    if (exists(candidate)) return candidate;
  }
  for (const candidate of CLI_CANDIDATES) if (exists(candidate)) return candidate;
  return "cast";
}

function statusToReadiness(status) {
  switch (status) {
    case "granted": return "granted";
    case "not-granted": return "off";
    case "unsupported": return "n/a";
    default: return "unknown";
  }
}

function unknownAll() {
  return { computerAccessibility: "unknown", computerScreen: "unknown" };
}

// `cast computer` prints its result as JSON on stdout and its failures the
// same way, with `ok: false` and a code — so a non-zero exit still carries the
// answer, and the exit status alone is never the account of what happened.
function runCli({ cli, args, timeout }) {
  return new Promise((resolve) => {
    execFile(cli, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
      try {
        const parsed = JSON.parse(String(stdout));
        resolve(parsed && typeof parsed === "object" ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

// `run` and `platform` are injected so the pure parts stay testable under
// plain node, the way osPermissions.js does it.
function createComputerPermissions({ run, platform = process.platform, cli = resolveCli() } = {}) {
  const invoke = run ?? ((args, timeout) => runCli({ cli, args, timeout }));

  function owns(kind) {
    return COMPUTER_KINDS.includes(kind);
  }

  async function getAll() {
    if (platform !== "darwin") return { computerAccessibility: "n/a", computerScreen: "n/a" };
    const result = await invoke(["computer", "permissions", "--json"], READ_TIMEOUT_MS);
    if (!result || result.ok === false || !Array.isArray(result.permissions)) return unknownAll();
    const byId = new Map(result.permissions.map((p) => [p && p.id, p && p.status]));
    return {
      computerAccessibility: statusToReadiness(byId.get("accessibility")),
      computerScreen: statusToReadiness(byId.get("screenshots")),
    };
  }

  // The human clicked. `capabilities` is the CLI's own materialization path,
  // and the helper has to exist on disk before it can put its window on
  // screen — with nothing there, `--open-settings` has nothing to open.
  async function openSettings(kind) {
    const id = PERMISSION_ID[kind];
    if (!id || platform !== "darwin") return false;
    await invoke(["computer", "capabilities", "--json"], READ_TIMEOUT_MS);
    const result = await invoke(["computer", "permissions", "--open-settings", "--id", id, "--json"], READ_TIMEOUT_MS);
    return !!result && result.ok !== false;
  }

  return { owns, getAll, openSettings };
}

module.exports = {
  COMPUTER_KINDS,
  PERMISSION_ID,
  READ_TIMEOUT_MS,
  resolveCli,
  statusToReadiness,
  createComputerPermissions,
};
