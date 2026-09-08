#!/usr/bin/env node

// Post-build gate: does the shipped artifact actually carry the PostHog write
// key it is supposed to carry?
//
// Why (ct-49565). Vite inlines `import.meta.env.VITE_POSTHOG_KEY` at build
// time, and when the value is undefined the minifier removes the whole
// `posthog.init` branch as dead code. So a build that forgot the env var
// leaves NO trace of PostHog in the bundle: it deploys green, it serves fine,
// and it reports nothing. That is exactly how codecast ran with zero product
// analytics until 2026-08-08, and nothing failed to say so. This script turns
// that silence into a failed build.
//
// It also asserts the reverse where a key does not belong. The CLI has no
// analytics transport, so a `phc_` string inside a CLI binary means someone
// added one without the event catalog, the burst cap or the DO_NOT_TRACK opt
// out — the checks a terminal tool needs most.
//
// Usage:
//   node scripts/ci/verify-telemetry-key.mjs                    # check what exists
//   node scripts/ci/verify-telemetry-key.mjs --target web       # one target: web | cli
//   node scripts/ci/verify-telemetry-key.mjs --require          # a missing artifact fails too
//   node scripts/ci/verify-telemetry-key.mjs --key phc_xxx      # explicit key
//
// Each build step names the target it just produced, so `--require` means
// "this artifact must exist and must be right" rather than "every artifact in
// the repo must exist".
//
// The key comes from --key, else VITE_POSTHOG_KEY. With neither, a "present"
// target cannot be checked: that is a failure under --require and a skip
// otherwise. Requiring is on by default inside a Railway build, which is the
// one place that is supposed to hold the key — a Railway deploy with the
// variable missing is exactly the silent shipping this guards against. A
// developer's local build and the CI build job carry no key and skip.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");

// Each target names an artifact and what the key must do there. A new surface
// that ships telemetry is one entry, not a second script.
export const TARGETS = [
  {
    id: "web",
    name: "web dist",
    path: "packages/web/dist",
    // Text assets only: the key lands in the JS bundle, and scanning fonts and
    // images for it just burns IO.
    extensions: [".js", ".mjs", ".html", ".css"],
    expect: "present",
    why: "Railway bakes VITE_POSTHOG_KEY into the bundle; without it the whole PostHog branch is eliminated.",
  },
  {
    id: "cli",
    name: "CLI binaries",
    path: "packages/web/binaries",
    // Compiled bun binaries: no extension on unix, .exe on windows.
    match: (file) => /^codecast-[a-z0-9-]+(\.exe)?$/.test(file),
    expect: "absent",
    why: "The CLI ships no analytics transport. A key here means telemetry was wired up outside the catalog and the opt out.",
  },
];

function listFiles(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  return found;
}

function selects(target, file) {
  const name = file.split("/").pop() ?? "";
  if (target.match) return target.match(name);
  return target.extensions.some((ext) => name.endsWith(ext));
}

// A phc_ key is publishable, but printing it whole into a public CI log is
// still needless: the prefix says which key ran.
const short = (value) => `${value.slice(0, 12)}… (length ${value.length})`;

/**
 * Check every target and return the problems found. Pure enough to test: the
 * caller supplies the root, the key and the artifact policy.
 */
export function verifyTelemetryKey({ root = repoRoot, key = "", requireArtifacts = false, targets = TARGETS } = {}) {
  const errors = [];
  const notes = [];

  for (const target of targets) {
    const dir = join(root, target.path);
    let exists = false;
    try {
      exists = statSync(dir).isDirectory();
    } catch {
      exists = false;
    }

    const missing = (message) => (requireArtifacts ? errors.push(message) : notes.push(`skip: ${message}`));

    if (!exists) {
      missing(`${target.name}: no artifact at ${target.path} — nothing was built`);
      continue;
    }

    const files = listFiles(dir).filter((file) => selects(target, file));
    if (files.length === 0) {
      missing(`${target.name}: ${target.path} holds no files this check reads`);
      continue;
    }
    if (target.expect === "present" && !key) {
      missing(`${target.name}: no key to look for — set VITE_POSTHOG_KEY or pass --key. ${target.why}`);
      continue;
    }

    // An "absent" target looks for any PostHog project key, not just this
    // build's: the point is that no key at all reached the binary.
    const needle = target.expect === "present" ? key : "phc_";
    const hits = files.filter((file) => {
      try {
        return readFileSync(file, "latin1").includes(needle);
      } catch {
        return false;
      }
    });

    if (target.expect === "present" && hits.length === 0) {
      errors.push(
        `${target.name}: the PostHog write key ${short(key)} is in none of the ${files.length} files under ` +
          `${target.path}. ${target.why}`,
      );
      continue;
    }
    if (target.expect === "absent" && hits.length > 0) {
      errors.push(
        `${target.name}: a PostHog key appears in ${hits.map((f) => f.replace(`${root}/`, "")).join(", ")}. ` +
          target.why,
      );
      continue;
    }

    notes.push(
      target.expect === "present"
        ? `ok: ${target.name} carries ${short(key)} in ${hits.length} of ${files.length} files`
        : `ok: ${target.name} carries no PostHog key across ${files.length} files`,
    );
  }

  return { errors, notes };
}

// Run only as a script, so the test can import the checker.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const wanted = args.flatMap((arg, i) => (arg === "--target" ? [args[i + 1]] : []));
  const targets = wanted.length ? TARGETS.filter((t) => wanted.includes(t.id)) : TARGETS;
  if (wanted.length && targets.length !== wanted.length) {
    console.error(`::error::unknown --target; known ids: ${TARGETS.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }
  const { errors, notes } = verifyTelemetryKey({
    key: valueOf("--key") || process.env.VITE_POSTHOG_KEY || "",
    requireArtifacts: args.includes("--require") || !!process.env.RAILWAY_ENVIRONMENT,
    targets,
  });
  for (const note of notes) console.log(note);
  for (const error of errors) console.error(`::error::${error}`);
  process.exit(errors.length ? 1 : 0);
}
