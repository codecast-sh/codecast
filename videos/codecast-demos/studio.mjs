// Screen-studio engine: turns a compact per-video scene spec + ElevenLabs VO timing
// into one HyperFrames composition (DOM with data-* clips + a seek-safe GSAP timeline).
// Reused by all five demos — the single source of truth for camera, captions, cards, spotlights.
import { readFileSync } from "fs";

const W = 1920, H = 1080;
const CROSSFADE = 0.5;   // seconds of overlap when cutting between two images
const TAIL = 1.1;        // extra hold after the last beat's narration ends

// Codecast's real Solarized-dark tokens (packages/web/app/globals.css)
export const TOK = {
  bg: "#00212b", bgAlt: "#073642", card: "#08404e", border: "#586e75",
  text: "#fdf6e3", dim: "#93a1a1", cyan: "#2aa198", green: "#859900",
  blue: "#268bd2", yellow: "#b58900", orange: "#cb4b16", violet: "#6c71c4",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Group consecutive beats that share the same image into one camera "run".
function runsFromBeats(beats) {
  const runs = [];
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const last = runs[runs.length - 1];
    if (last && last.img === b.img) last.beats.push({ ...b, idx: i });
    else runs.push({ img: b.img, beats: [{ ...b, idx: i }] });
  }
  return runs;
}

// cam translate to center composition-space point (cx,cy) at scale S,
// with transform-origin 50% 50%:  x = -S*(cx - W/2),  y = -S*(cy - H/2)
function camFor([fx, fy, S]) {
  const cx = fx * W, cy = fy * H;
  return { S, x: -S * (cx - W / 2), y: -S * (cy - H / 2) };
}

export function renderComposition(scene, voDir) {
  const timing = JSON.parse(readFileSync(`${voDir}/${scene.id}.timing.json`, "utf8"));
  const introDur = scene.introDur ?? 3.0;
  const audioStart = introDur - 0.25;               // let VO breathe in slightly under the card
  const beats = scene.beats.map((b, i) => ({
    ...b,
    start: audioStart + timing.beats[i].start,
    dur: timing.beats[i].dur,
  }));
  const lastBeat = beats[beats.length - 1];
  const beatsEnd = lastBeat.start + lastBeat.dur + TAIL;
  const outroDur = scene.outroDur ?? 3.4;
  const duration = +(beatsEnd + outroDur).toFixed(2);

  const dom = [];
  const PLAN = { duration, cards: [], worlds: [], caps: [], spots: [] };
  let uid = 0;
  const nid = (p) => `${p}${uid++}`;

  // ---- background (full-duration ground) ----
  dom.push(
    `<div id="bg" class="clip" data-start="0" data-duration="${duration}" data-track-index="0" ` +
    `style="position:absolute;inset:0;background:` +
    `radial-gradient(120% 120% at 50% 0%, ${TOK.bgAlt} 0%, ${TOK.bg} 55%, #001820 100%);"></div>`
  );

  // ---- intro title card ----
  {
    const id = nid("card");
    dom.push(cardHTML(id, "title", scene.introTitle, scene.introSub, scene.badge));
    PLAN.cards.push({ sel: `#${id}`, start: 0, dur: introDur + 0.35, kind: "title" });
    // placement on timeline handled below; but card clip needs data-*:
    domSetClip(dom, id, 0, introDur + 0.5, 60);
  }

  // ---- image runs with camera + captions + spotlights ----
  const runs = runsFromBeats(beats);
  runs.forEach((run, ri) => {
    const first = run.beats[0], last = run.beats[run.beats.length - 1];
    const runStart = ri === 0 ? first.start - 0.6 : first.start - CROSSFADE;
    const runEnd = (ri === runs.length - 1)
      ? beatsEnd
      : run.beats[run.beats.length - 1].start + last.dur + CROSSFADE * 0.5;
    const worldId = nid("world");
    const imgSrc = scene.images[run.img];
    // Spotlights live INSIDE .world so the camera transform carries them onto
    // their target exactly (screen-space placement drifts off under zoom).
    const spotEls = [];
    run.beats.forEach((b) => {
      if (!b.spot) return;
      const sId = nid("spot");
      const scale = b.tgt[2];
      spotEls.push(spotHTML(sId, b.spot, b.spotLabel, scale));
      PLAN.spots.push({ sel: `#${sId}`, start: b.start, dur: b.dur + 0.4 });
    });
    dom.push(
      `<div id="${worldId}" class="clip" data-start="${fx(runStart)}" data-duration="${fx(runEnd - runStart)}" data-track-index="10" ` +
      `style="position:absolute;inset:0;overflow:hidden;opacity:0;">` +
        `<div class="world" style="position:absolute;inset:0;transform-origin:50% 50%;will-change:transform;">` +
          `<img src="${imgSrc}" width="${W}" height="${H}" style="display:block;width:${W}px;height:${H}px;" />` +
          spotEls.join("") +
        `</div>` +
        `<div style="position:absolute;inset:0;box-shadow:inset 0 0 200px 40px rgba(0,10,14,0.55);pointer-events:none;"></div>` +
      `</div>`
    );
    // camera keyframes: one per beat in the run (relative to world clip start)
    const moves = run.beats.map((b, bi) => {
      const cam = camFor(b.tgt);
      const at = +(b.start - runStart).toFixed(3);
      return { at, dur: bi === 0 ? (ri === 0 ? 1.4 : 0.9) : 1.5, ...cam, ease: bi === 0 ? "power2.out" : "power2.inOut" };
    });
    PLAN.worlds.push({
      sel: `#${worldId}`, start: runStart, dur: runEnd - runStart,
      fadeIn: ri === 0 ? 0.8 : CROSSFADE, fadeOut: ri === runs.length - 1 ? 0.6 : CROSSFADE,
      moves,
    });
  });

  // ---- captions (lower third), one per beat ----
  beats.forEach((b, i) => {
    const cId = nid("cap");
    dom.push(captionHTML(cId, timing.beats[i].text));
    const capDur = (i < beats.length - 1)
      ? Math.max(b.dur + 0.35, beats[i + 1].start - b.start)
      : b.dur + TAIL;
    domSetClip(dom, cId, b.start - 0.12, capDur, 40);
    PLAN.caps.push({ sel: `#${cId}`, start: b.start - 0.12, dur: capDur });
  });

  // ---- outro card ----
  {
    const id = nid("card");
    dom.push(cardHTML(id, "outro", scene.outroTitle, scene.outroSub, null));
    domSetClip(dom, id, beatsEnd - 0.2, outroDur + 0.4, 60);
    PLAN.cards.push({ sel: `#${id}`, start: beatsEnd - 0.2, dur: outroDur + 0.4, kind: "outro" });
  }

  // ---- narration audio ----
  dom.push(
    `<audio data-start="${fx(audioStart)}" data-track-index="90" data-volume="1" src="${scene.audio}"></audio>`
  );

  return page(scene.id, duration, dom.join("\n      "), PLAN);
}

const fx = (n) => +(+n).toFixed(3);

// Patch a clip element's data-start/data-duration/data-track-index in the DOM array (by id).
function domSetClip(dom, id, start, dur, track) {
  const i = dom.findIndex((s) => s.includes(`id="${id}"`));
  if (i < 0) return;
  dom[i] = dom[i].replace(
    `id="${id}"`,
    `id="${id}" data-start="${fx(start)}" data-duration="${fx(dur)}" data-track-index="${track}"`
  );
}

function cardHTML(id, kind, title, sub, badge) {
  const accent = kind === "title" ? TOK.cyan : TOK.green;
  return (
    `<div id="${id}" class="clip card" ` +
    `style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;` +
    `text-align:center;padding:0 12%;">` +
      (badge ? `<div class="c-badge" style="font-family:var(--mono);font-size:20px;letter-spacing:6px;text-transform:uppercase;` +
        `color:${TOK.bg};background:${accent};padding:8px 20px;border-radius:6px;font-weight:700;">${esc(badge)}</div>` : "") +
      `<div class="c-title" style="font-family:var(--display);font-weight:600;font-size:118px;line-height:1.0;letter-spacing:-2px;` +
      `color:${TOK.text};">${esc(title)}</div>` +
      `<div class="c-accent" style="width:0;height:5px;border-radius:3px;background:${accent};box-shadow:0 0 24px ${accent};"></div>` +
      `<div class="c-sub" style="font-family:var(--mono);font-weight:400;font-size:34px;color:${TOK.dim};max-width:1180px;line-height:1.45;">${esc(sub)}</div>` +
    `</div>`
  );
}

function captionHTML(id, text) {
  return (
    `<div id="${id}" class="clip cap" ` +
    `style="position:absolute;left:0;right:0;bottom:70px;display:flex;justify-content:center;pointer-events:none;">` +
      `<div class="cap-inner" style="display:flex;align-items:stretch;gap:0;max-width:1440px;">` +
        `<div style="width:6px;border-radius:3px 0 0 3px;background:${TOK.cyan};box-shadow:0 0 18px ${TOK.cyan};"></div>` +
        `<div style="font-family:var(--mono);font-weight:500;font-size:33px;line-height:1.4;color:${TOK.text};` +
        `background:rgba(3,26,33,0.86);backdrop-filter:blur(8px);padding:20px 30px;border-radius:0 10px 10px 0;` +
        `border:1px solid rgba(88,110,117,0.4);border-left:none;">${esc(text)}</div>` +
      `</div>` +
    `</div>`
  );
}

// Spotlight in WORLD coordinates (nested in .world, so the camera carries it onto
// the target). Border thickness scales with zoom; the label counter-scales (1/scale)
// so it stays a readable, constant on-screen size.
function spotHTML(id, [x, y, w, h], label, scale) {
  const L = x * W, T = y * H, WW = w * W, HH = h * H;
  const bw = +(2.4 / scale).toFixed(2);
  const inv = +(1 / scale).toFixed(4);
  return (
    `<div id="${id}" class="spot" style="position:absolute;left:${fx(L)}px;top:${fx(T)}px;width:${fx(WW)}px;height:${fx(HH)}px;` +
    `border:${bw}px solid ${TOK.cyan};border-radius:${fx(12 / scale)}px;` +
    `box-shadow:0 0 0 ${fx(1.5 / scale)}px rgba(42,161,152,0.25),0 0 ${fx(34 / scale)}px ${fx(5 / scale)}px rgba(42,161,152,0.4);` +
    `pointer-events:none;">` +
      (label ? `<div style="position:absolute;bottom:100%;left:0;transform:scale(${inv});transform-origin:bottom left;margin-bottom:${fx(8 / scale)}px;` +
        `font-family:var(--mono);font-size:19px;font-weight:700;letter-spacing:2px;` +
        `text-transform:uppercase;color:${TOK.bg};background:${TOK.cyan};padding:5px 12px;border-radius:6px;white-space:nowrap;">${esc(label)}</div>` : "") +
    `</div>`
  );
}

function page(id, duration, body, plan) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&display=swap" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      :root { --mono: "JetBrains Mono", monospace; --display: "Fraunces", "JetBrains Mono", serif; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: ${TOK.bg}; }
      body { font-family: var(--mono); }
      .card, .cap, .spot { opacity: 0; }
      img { image-rendering: -webkit-optimize-contrast; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="${id}" data-start="0" data-duration="${duration}" data-width="1920" data-height="1080">
      ${body}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      const PLAN = ${JSON.stringify(plan)};

      // ---- title / outro cards ----
      for (const c of PLAN.cards) {
        const el = document.querySelector(c.sel);
        const title = el.querySelector(".c-title");
        const accent = el.querySelector(".c-accent");
        const sub = el.querySelector(".c-sub");
        const badge = el.querySelector(".c-badge");
        const inD = 0.7, outD = 0.55, hold = c.dur - inD - outD;
        tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: inD, ease: "power2.out" }, c.start);
        if (badge) tl.from(badge, { opacity: 0, y: -14, duration: 0.5, ease: "power3.out" }, c.start + 0.1);
        tl.from(title, { opacity: 0, y: 34, filter: "blur(6px)", duration: 0.85, ease: "power3.out" }, c.start + 0.12);
        tl.fromTo(accent, { width: 0 }, { width: 240, duration: 0.7, ease: "power2.out" }, c.start + 0.5);
        tl.from(sub, { opacity: 0, y: 16, duration: 0.7, ease: "power3.out" }, c.start + 0.55);
        tl.to(el, { opacity: 0, duration: outD, ease: "power2.in" }, c.start + inD + Math.max(hold, 0.4));
      }

      // ---- image worlds + virtual camera ----
      for (const w of PLAN.worlds) {
        const wrap = document.querySelector(w.sel);
        const world = wrap.querySelector(".world");
        const cam = { S: w.moves[0].S, x: w.moves[0].x, y: w.moves[0].y };
        const apply = () => { world.style.transform = "translate(" + cam.x + "px," + cam.y + "px) scale(" + cam.S + ")"; };
        apply();
        tl.fromTo(wrap, { opacity: 0 }, { opacity: 1, duration: w.fadeIn, ease: "power1.out" }, w.start);
        tl.to(wrap, { opacity: 0, duration: w.fadeOut, ease: "power1.in" }, w.start + w.dur - w.fadeOut);
        // camera keyframes (relative → absolute time)
        w.moves.forEach((m, i) => {
          if (i === 0) { // ensure correct pose at clip start under seek
            tl.set(cam, { S: m.S, x: m.x, y: m.y, onUpdate: apply }, w.start + Math.max(m.at - 0.001, 0));
            return;
          }
          tl.to(cam, { S: m.S, x: m.x, y: m.y, duration: m.dur, ease: m.ease, onUpdate: apply }, w.start + m.at);
        });
        // continuous micro-drift so the frame never freezes
        const drift = { p: 0 };
        tl.to(drift, { p: Math.PI * 2 * 1.5, duration: w.dur, ease: "none",
          onUpdate: () => {
            const dx = Math.sin(drift.p) * 5, dy = Math.sin(drift.p * 1.3) * 3;
            world.style.transform = "translate(" + (cam.x + dx) + "px," + (cam.y + dy) + "px) scale(" + cam.S + ")";
          } }, w.start);
      }

      // ---- spotlights ----
      for (const s of PLAN.spots) {
        tl.fromTo(s.sel, { opacity: 0, scale: 1.06 }, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(1.8)", transformOrigin: "50% 50%" }, s.start);
        tl.to(s.sel, { opacity: 0, duration: 0.35, ease: "power2.in" }, s.start + s.dur - 0.35);
      }

      // ---- captions ----
      for (const c of PLAN.caps) {
        tl.fromTo(c.sel, { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" }, c.start);
        tl.to(c.sel, { opacity: 0, y: -8, duration: 0.3, ease: "power2.in" }, c.start + c.dur - 0.3);
      }

      tl.set({}, {}, PLAN.duration); // extend to full duration
      window.__timelines["${id}"] = tl;
    </script>
  </body>
</html>`;
}
