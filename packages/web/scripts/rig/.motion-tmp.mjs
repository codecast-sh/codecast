import { killChrome, launchChrome } from "./chrome.mjs";
import { connect, connectTarget, newTarget, sleep } from "./cdp.mjs";
import { APP_URL, signIn } from "./auth.mjs";
import { PAGE_LIB } from "./page.mjs";
import { BAR } from "./legs.mjs";
import { FAKE_BRIDGE, STATES_LIB } from "./states.mjs";
const DIR = "/tmp/facemotion";
const PORT = 9617;
const FLOAT = '.face-row[data-density="float"]';
const child = await launchChrome({ port: PORT, profile: `${DIR}/prof`, fresh: true });
try {
  const bar = await connect(PORT, /about:blank|localhost/);
  await bar.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await signIn(bar, "riley");
  await bar.evaluate(PAGE_LIB);
  await bar.evaluate(`__rig.waitFor("!s.missing && s.entries.length > 0", 240000)`);
  const t = await newTarget(PORT);
  const float = await connectTarget(t);
  await float.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await float.addInitScript(FAKE_BRIDGE);
  await float.navigate(`${APP_URL}/call-panel`);
  const roster = `(async () => { for (let i = 0; i < 2400; i++) { const st = window.__inboxStore?.getState(); if (st?.currentUser?._id && (st.teamMembers ?? []).length > 1 && window.__faceRow) return st.teamMembers.length; await new Promise((r) => setTimeout(r, 100)); } throw new Error("no roster"); })()`;
  await bar.evaluate(roster);
  await float.evaluate(roster);
  const LIB = `(() => {
    const st = __inboxStore.getState();
    const me = String(st.currentUser._id);
    const them = (st.teamMembers || []).find((m) => String(m._id) !== me);
    const tid = String(them._id);
    const img = them.image || them.github_avatar_url;
    const fakes = ["Cam", "Jason", "Mira", "Theo"].map((n, i) => ({ _id: "fake" + i, name: n, image: i % 2 ? img : undefined, presence_state: "active", status: "online" }));
    const roster = [...(st.teamMembers || []).map((m) => String(m._id) === tid ? { ...m, presence_state: "active", status: "online" } : m), ...fakes];
    const dm = "dm:" + [me, tid].sort().join(":");
    const seat = (uid) => ({ user_id: uid });
    const call = { phase: "connected", roomKey: dm, muted: false, micDenied: false, camera: false, speaking: [] };
    const extra = { roster, unread: new Map([[tid, 3], ["fake2", 12]]), ask: new Map([["fake0", 1]]) };
    window.__m = {
      idle() { __faceRow.fake({ input: extra }); return "idle"; },
      live() { __faceRow.fake({ walkie: { liveRoom: { key: dm, mode: "call", since: Date.now() - 3000 }, sending: null, incoming: null, canReply: false }, input: { ...extra, call, occupancy: { [dm]: [seat(me), seat(tid)] } } }); return "live"; },
    };
    return roster.length;
  })()`;
  console.log("roster", await bar.evaluate(LIB), await float.evaluate(LIB));
  const apply = (page, name) => page.evaluate(`__m.${name}()`);
  for (const size of [64, 128]) {
    await float.evaluate(`(() => { __inboxStore.getState().updateClientUI({ float_face_size: ${size} }); return "ok"; })()`);
    await sleep(1500);
    await float.evaluate(roster);
    await float.evaluate(LIB);
    await apply(float, "idle"); await apply(bar, "idle");
    await sleep(700);
    if (size === 64) await bar.screenshot(`${DIR}/bar-idle.png`, BAR);
    await float.screenshot(`${DIR}/float${size}-idle.png`, FLOAT);
    await apply(float, "live"); await apply(bar, "live");
    for (const ms of [90, 180, 300]) {
      await sleep(ms === 90 ? 90 : ms === 180 ? 90 : 120);
      await float.screenshot(`${DIR}/float${size}-in-${ms}.png`, FLOAT);
      if (size === 64) await bar.screenshot(`${DIR}/bar-in-${ms}.png`, BAR);
    }
    await sleep(700);
    await float.screenshot(`${DIR}/float${size}-live.png`, FLOAT);
    if (size === 64) await bar.screenshot(`${DIR}/bar-live.png`, BAR);
    await apply(float, "idle"); await apply(bar, "idle");
    await sleep(200);
    await float.screenshot(`${DIR}/float${size}-out-200.png`, FLOAT);
    await sleep(800);
  }
  await apply(float, "live");
  await sleep(1200);
  console.log(await float.evaluate(`(() => { const c = document.querySelector('.face-row-stack-count'); if (!c) return 'no count'; const r = c.getBoundingClientRect(); const cs = getComputedStyle(c); return JSON.stringify({r:[r.left,r.top,r.width,r.height], op: cs.opacity, anim: cs.animationName, row: document.querySelector('.face-row[data-density=float]').getBoundingClientRect().width, vw: innerWidth}); })()`));
  await apply(float, "idle");
  await sleep(1200);
  console.log(await float.evaluate(`(async () => { const out = []; __m.live(); const t0 = performance.now(); for (let i = 0; i < 14; i++) { await new Promise((r) => setTimeout(r, 50)); const seats = [...document.querySelectorAll('.face-row[data-density=float] .face-seat')].slice(-4); out.push(Math.round(performance.now() - t0) + ':' + seats.map((s) => parseFloat(getComputedStyle(s).getPropertyValue('--face')).toFixed(0)).join(',')); } return out.join(' | '); })()`));
  console.log(await float.evaluate(`JSON.stringify([...document.querySelectorAll('.face-row[data-density="float"] .face-seat')].map(s=>[s.dataset.stacked||'-', getComputedStyle(s).getPropertyValue('--face')]))`));
} finally {
  killChrome(child);
}
