#!/usr/bin/env node
/**
 * publora — thin CLI over the Publora API (https://docs.publora.com) for
 * codecast social posting. One POST publishes to every connected platform.
 *
 * Auth: reads PUBLORA_API_KEY, else ~/.config/codecast/publora_key.
 * Get a key: app.publora.com → API → Generate. Connect accounts in the
 * dashboard first — the API posts to connections, it cannot create them.
 *
 * Usage:
 *   node scripts/publora.mjs connections            # list connected accounts + health
 *   node scripts/publora.mjs limits                 # live per-platform char/media limits
 *   node scripts/publora.mjs post --content "..."   # schedule to ALL connections (+5 min)
 *   node scripts/publora.mjs post --content - <<'EOF'   # content from stdin
 *   multi-line post
 *   EOF
 *     --platforms twitter-123,bluesky-did:plc:x     # subset (default: all connected)
 *     --at 2026-08-10T16:00:00Z | --at +6h          # schedule time (default +5 min)
 *     --media https://…/a.png,https://…/b.mp4       # public https URLs, one-shot attach
 *     --draft                                       # create a draft, no scheduledTime
 *     --dry                                         # print the payload, send nothing
 *   node scripts/publora.mjs list [--status scheduled|published|failed]
 *   node scripts/publora.mjs get <postGroupId>
 *   node scripts/publora.mjs logs <postGroupId>
 *   node scripts/publora.mjs delete <postGroupId>
 *
 * No dependencies — node >= 18.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const BASE = "https://api.publora.com/api/v1";

const key =
  process.env.PUBLORA_API_KEY ||
  (() => {
    try {
      return readFileSync(`${homedir()}/.config/codecast/publora_key`, "utf8").trim();
    } catch {
      return null;
    }
  })();

if (!key) {
  console.error(
    "No API key. Set PUBLORA_API_KEY or write the key to ~/.config/codecast/publora_key\n" +
      "(app.publora.com → API → Generate)."
  );
  process.exit(2);
}

const api = async (method, path, body, extraHeaders = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-publora-key": key,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${path}`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json;
};

// ── arg parsing ──────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? true : rest[++i];
  else positional.push(rest[i]);
}

const out = (o) => console.log(JSON.stringify(o, null, 2));

const parseAt = (at) => {
  if (!at) return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const rel = /^\+(\d+)([mhd])$/.exec(at);
  if (rel) {
    const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]];
    return new Date(Date.now() + Number(rel[1]) * mult).toISOString();
  }
  const d = new Date(at);
  if (isNaN(d)) {
    console.error(`Bad --at value: ${at}`);
    process.exit(2);
  }
  return d.toISOString();
};

switch (cmd) {
  case "connections":
    out(await api("GET", "/platform-connections"));
    break;

  case "limits":
    out(await api("GET", "/platform-limits"));
    break;

  case "post": {
    let content = flags.content;
    if (content === "-" || content === undefined) content = readFileSync(0, "utf8").trim();
    if (!content) {
      console.error("Empty content.");
      process.exit(2);
    }

    let platforms;
    if (flags.platforms) {
      platforms = String(flags.platforms).split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      const conns = await api("GET", "/platform-connections");
      const all = conns.connections ?? [];
      const dead = all.filter((c) => c.tokenStatus === "expired");
      for (const c of dead) console.error(`skipping ${c.platformId} (token expired — reconnect in dashboard)`);
      platforms = all.filter((c) => c.tokenStatus !== "expired").map((c) => c.platformId).filter(Boolean);
      if (!platforms.length) {
        console.error("No connected platforms. Connect accounts at app.publora.com first.");
        process.exit(1);
      }
    }

    const body = { content, platforms };
    if (!flags.draft) body.scheduledTime = parseAt(flags.at);
    if (flags.media) body.mediaUrls = String(flags.media).split(",").map((s) => s.trim()).filter(Boolean);
    // One content per post — the API has no per-platform text override. For
    // platform-tuned copy, call `post` once per platform group with --platforms.

    if (flags.dry) {
      out(body);
      break;
    }
    const res = await api("POST", "/create-post", body, { "Idempotency-Key": randomUUID() });
    out(res);
    if (res.warnings) console.error("⚠ accepted with warnings — see above");
    break;
  }

  case "list": {
    const q = flags.status ? `?status=${flags.status}` : "";
    out(await api("GET", `/list-posts${q}`));
    break;
  }

  case "get":
    out(await api("GET", `/get-post/${positional[0]}`));
    break;

  case "logs":
    out(await api("GET", `/post-logs/${positional[0]}`));
    break;

  case "delete":
    out(await api("DELETE", `/delete-post/${positional[0]}`));
    break;

  default:
    console.error("Commands: connections | limits | post | list | get | logs | delete  (see header for flags)");
    process.exit(2);
}
