#!/usr/bin/env node
// Generate ElevenLabs voiceover per beat, concat into one narration wav per demo,
// and emit timing JSON (beat start/dur) that the composition builder paces the camera to.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error("ELEVENLABS_API_KEY missing"); process.exit(1); }
const VOICE = process.env.HF_VOICE || "cjVigY5qzO86Huf0OWal"; // Eric — Smooth, Trustworthy
const MODEL = "eleven_multilingual_v2";
const DIR = new URL(".", import.meta.url).pathname;
const VO = DIR + "vo";
const only = process.argv[2]; // optional: demo1

const scripts = JSON.parse(readFileSync(VO + "/scripts.json", "utf8"));
mkdirSync(VO + "/beats", { recursive: true });

const ffprobeDur = (f) =>
  parseFloat(execSync(
    `ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${f}"`,
    { encoding: "utf8" }).trim());

async function tts(text, out) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`,
    { method: "POST",
      headers: { "xi-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({
        text, model_id: MODEL,
        voice_settings: { stability: 0.42, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
      }) });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0,200)}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

for (const [id, spec] of Object.entries(scripts)) {
  if (only && id !== only) continue;
  const beats = spec.beats;
  const timing = [];
  const beatFiles = [];
  let t = 0;
  const GAP = 0.45; // breathing pause between beats (seconds)
  for (let i = 0; i < beats.length; i++) {
    const mp3 = `${VO}/beats/${id}-${String(i).padStart(2, "0")}.mp3`;
    if (!existsSync(mp3) || process.env.FORCE) {
      await tts(beats[i], mp3);
      process.stdout.write(`  ${id} beat ${i} ✓\n`);
    }
    const d = ffprobeDur(mp3);
    timing.push({ i, text: beats[i], start: +t.toFixed(3), dur: +d.toFixed(3) });
    beatFiles.push({ mp3, dur: d });
    t += d + GAP;
  }
  const total = +(t - GAP).toFixed(3);
  // Concat with silence gaps: build a filter that pads each beat with GAP of silence, then concat.
  const inputs = beatFiles.map((b) => `-i "${b.mp3}"`).join(" ");
  const pads = beatFiles.map((_, i) =>
    `[${i}:a]apad=pad_dur=${GAP},aresample=44100[a${i}]`).join(";");
  const concat = beatFiles.map((_, i) => `[a${i}]`).join("") + `concat=n=${beatFiles.length}:v=0:a=1[out]`;
  const outWav = `${VO}/${id}.wav`;
  execSync(
    `ffmpeg -y ${inputs} -filter_complex "${pads};${concat}" -map "[out]" -ac 2 -ar 44100 "${outWav}" 2>/dev/null`,
    { stdio: "inherit" });
  const realTotal = ffprobeDur(outWav);
  writeFileSync(`${VO}/${id}.timing.json`, JSON.stringify({ id, voice: VOICE, total: +realTotal.toFixed(3), beats: timing }, null, 2));
  console.log(`${id}: ${beats.length} beats, ${realTotal.toFixed(1)}s → ${id}.wav`);
}
