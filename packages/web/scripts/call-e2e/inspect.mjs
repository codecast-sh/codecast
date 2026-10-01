#!/usr/bin/env node
// What LiveKit itself sees in a room: who is in it, which tracks each
// publishes, and the room's egresses (recordings). Reads the media server's
// own API, not Convex, so it answers "did the track really get published" and
// "is the egress really running" independently of anything the app believes.
//
//   node inspect.mjs                      every active room with its counts
//   node inspect.mjs <room>               participants, tracks and egresses
//   node inspect.mjs <room> --watch 2     redraw every 2 s until Ctrl-C
//   node inspect.mjs <room> --wait-for camera,screen_share [--from <identity>] [--timeout 30]
//                                         exit 0 once every listed source is
//                                         published (by <identity> when given),
//                                         3 on timeout; for scripted checks
//
//   --egress-limit N    how many egresses to list, newest first (default 10;
//                       active ones always show)
//   --json              the raw answers: { rooms } or { room, participants, egresses }
//   --refresh-env       re-read LIVEKIT_* from the Convex env (livekit.mjs)
//
// Sources are LiveKit's names, lowercased: camera, microphone, screen_share,
// screen_share_audio.
import { die, loadLivekitEnv, parseArgs, twirp } from "./livekit.mjs";

const { flags, positionals } = parseArgs(process.argv.slice(2), { booleans: ["json", "refresh-env"] });
const room = positionals[0];
const env = loadLivekitEnv({ refresh: Boolean(flags["refresh-env"]) });

// LiveKit's JSON uses proto field names, and enums arrive as names or as
// numbers depending on the server version; these read either.
const pick = (o, ...keys) => keys.map((k) => o?.[k]).find((v) => v !== undefined);
const SOURCES = ["unknown", "camera", "microphone", "screen_share", "screen_share_audio"];
const sourceName = (s) => (typeof s === "number" ? SOURCES[s] : String(s ?? "unknown").toLowerCase());
const TRACK_TYPES = ["audio", "video", "data"];
const typeName = (t) => (typeof t === "number" ? TRACK_TYPES[t] : String(t ?? "").toLowerCase());
const EGRESS_STATUS = ["starting", "active", "ending", "complete", "failed", "aborted", "limit_reached"];
const statusName = (s) => (typeof s === "number" ? EGRESS_STATUS[s] : String(s ?? "").replace(/^EGRESS_/, "").toLowerCase());
const ACTIVE = new Set(["starting", "active", "ending"]);

// LiveKit timestamps are seconds (rooms, participants) or nanoseconds
// (egress, file results); both become ISO time to the millisecond.
const iso = (v, unit) => {
  const n = Number(v ?? 0);
  if (!n) return "-";
  return new Date(unit === "ns" ? n / 1e6 : n * 1000).toISOString().replace("T", " ").slice(0, 23);
};
const durationOf = (ns) => {
  const s = Number(ns ?? 0) / 1e9;
  return s ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : "-";
};

async function snapshot() {
  const [parts, egress] = await Promise.all([
    // A room exists only while someone is in it; a 404 is an empty room.
    twirp(env, "RoomService", "ListParticipants", { room }, { roomAdmin: true }, room).catch((err) => {
      if (err.status === 404) return { open: false };
      throw err;
    }),
    twirp(env, "Egress", "ListEgress", { room_name: room }, { roomRecord: true }),
  ]);
  const egresses = (egress.items ?? []).sort((a, b) => Number(pick(b, "started_at", "startedAt") ?? 0) - Number(pick(a, "started_at", "startedAt") ?? 0));
  return { room, open: parts.open !== false, participants: parts.participants ?? [], egresses };
}

function describeEgress(e) {
  const kind = e.room_composite || e.roomComposite
    ? `composite (${pick(e.room_composite ?? e.roomComposite, "layout") || "default layout"})`
    : e.track || e.track_composite || e.trackComposite
      ? `track ${pick(e.track ?? {}, "track_id", "trackId") ?? ""}${e.track_composite || e.trackComposite ? " composite" : ""}`.trim()
      : e.web ? "web" : "participant";
  const files = [...(e.file_results ?? e.fileResults ?? []), ...(e.file ? [e.file] : [])];
  const fileLines = files.map(
    (f) => `      file ${f.filename ?? "?"}  started ${iso(pick(f, "started_at", "startedAt"), "ns")}  ${durationOf(f.duration)}  ${f.size ? `${(Number(f.size) / 1e6).toFixed(1)} MB` : ""}`.trimEnd(),
  );
  return [
    `  ${pick(e, "egress_id", "egressId")}  ${statusName(e.status).padEnd(13)} ${kind}  started ${iso(pick(e, "started_at", "startedAt"), "ns")}${e.error ? `  error: ${e.error}` : ""}`,
    ...fileLines,
  ].join("\n");
}

function render(s) {
  const lines = [
    s.open ? `${s.room}  ${s.participants.length} participant${s.participants.length === 1 ? "" : "s"}` : `${s.room}  not open (nobody is in it)`,
  ];
  for (const p of s.participants) {
    const kind = String(pick(p, "kind") ?? "");
    const tag = p.identity.startsWith("guest:") ? "  [guest]" : p.identity.startsWith("agent:") ? "  [agent]" : /egress/i.test(kind) || kind === "1" ? "  [egress]" : "";
    lines.push(`  ${p.name || "(no name)"}  ${p.identity}${tag}  joined ${iso(pick(p, "joined_at", "joinedAt"))}`);
    for (const t of p.tracks ?? []) {
      const dims = t.width ? ` ${t.width}x${t.height}` : "";
      lines.push(
        `      ${typeName(t.type).padEnd(5)} ${sourceName(t.source).padEnd(18)} ${t.sid}${dims}${t.muted ? "  muted" : ""}  ${pick(t, "mime_type", "mimeType") ?? ""}`.trimEnd(),
      );
    }
    if (!(p.tracks ?? []).length) lines.push("      (no tracks)");
  }
  const limit = Number(flags["egress-limit"] ?? 10);
  const shown = s.egresses.filter((e, i) => i < limit || ACTIVE.has(statusName(e.status)));
  const active = s.egresses.filter((e) => ACTIVE.has(statusName(e.status))).length;
  lines.push(`egresses  ${active} active, ${s.egresses.length} total${shown.length < s.egresses.length ? ` (newest ${shown.length} shown)` : ""}`);
  for (const e of shown) lines.push(describeEgress(e));
  return lines.join("\n");
}

if (!room && (flags["wait-for"] || flags.watch)) die("--wait-for and --watch need a room", 64);
if (!room) {
  const { rooms = [] } = await twirp(env, "RoomService", "ListRooms", {}, { roomList: true });
  if (flags.json) process.stdout.write(`${JSON.stringify({ rooms }, null, 2)}\n`);
  else if (!rooms.length) process.stdout.write("No active rooms.\n");
  else {
    for (const r of rooms.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const n = pick(r, "num_participants", "numParticipants") ?? 0;
      const pubs = pick(r, "num_publishers", "numPublishers") ?? 0;
      process.stdout.write(`${r.name}  ${n} in, ${pubs} publishing${r.active_recording || r.activeRecording ? ", recording" : ""}  since ${iso(pick(r, "creation_time", "creationTime"))}\n`);
    }
  }
  process.exit(0);
}

if (flags["wait-for"]) {
  const want = String(flags["wait-for"]).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const from = flags.from;
  const deadline = Date.now() + Number(flags.timeout ?? 30) * 1000;
  for (;;) {
    const s = await snapshot();
    const have = new Set(
      s.participants.filter((p) => !from || p.identity === from).flatMap((p) => (p.tracks ?? []).map((t) => sourceName(t.source))),
    );
    const missing = want.filter((w) => !have.has(w));
    if (!missing.length) {
      process.stdout.write(flags.json ? `${JSON.stringify(s, null, 2)}\n` : `${render(s)}\nall of ${want.join(", ")} published${from ? ` by ${from}` : ""}\n`);
      process.exit(0);
    }
    if (Date.now() > deadline) {
      process.stdout.write(`${render(s)}\n`);
      die(`timed out: ${missing.join(", ")} not published${from ? ` by ${from}` : ""}`, 3);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const watch = Number(flags.watch ?? 0);
do {
  const s = await snapshot();
  if (flags.json) process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  else process.stdout.write(`${watch ? "\x1b[2J\x1b[H" + new Date().toISOString() + "\n" : ""}${render(s)}\n`);
  if (watch) await new Promise((r) => setTimeout(r, watch * 1000));
} while (watch);
