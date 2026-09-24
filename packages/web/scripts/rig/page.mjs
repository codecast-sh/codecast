// The in page half of the rig: a recorder on the header's face row and the
// drivers that press what a person presses.
//
// THE RECORDER READS THE DOM, NOT THE MODEL. What the founder sees is the
// circle's `data-state`, the bridge's `data-link-kind` and the card's
// `data-card`; a model that is right while the DOM lags is the bug this rig
// exists to catch. A MutationObserver on the bar logs every change of those
// attributes per face with a wall clock stamp (Date.now, so two browsers'
// logs line up), and every face node is tagged at the start so the end can
// prove nobody was remounted across a state change.
//
// The drivers click the real elements: the face (which pins the card that
// holds Talk, Ring and Message), a card's action, an engagement card action. `.click()` reaches React's
// onClick; nothing here calls the engine directly, except the two fault
// injections (a LiveKit reconnect, a dead browser) that no button offers.
export const PAGE_LIB = String.raw`
(() => {
  // Reinstalled on every evaluate, so an edit to this file reaches a page
  // that is already up; the old ticker and recorder are shut first.
  if (window.__rig) { clearInterval(window.__rig.alive); window.__rig.stop?.(); }
  const R = (window.__rig = { seq: 0, log: [], t0: Date.now() });
  const row = () => document.querySelector('.face-row[data-density="bar"]');
  const bar = () => document.querySelector(".people-bar");
  const now = () => Date.now() - R.t0;
  // A person at the keyboard: the presence reporter reads idle time off the
  // last pointermove or keydown (lib/desktop.ts), and a browser nobody
  // touches reads "away" within minutes. Focus is emulated over CDP.
  R.alive = setInterval(() => window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 })), 4000);

  R.snap = () => {
    const r = row();
    if (!r) return { entries: [], card: "none", holding: false, live: false, missing: true };
    const entries = [];
    let link = null;
    for (const el of r.children) {
      if (el.classList.contains("face-link")) { link = el.dataset.linkKind ?? null; continue; }
      const id = el.dataset.faceId;
      if (!id) continue;
      const hit = el.querySelector("[data-state]");
      entries.push({ id, state: hit?.dataset.state ?? "?", me: hit?.dataset.me === "1", link });
      link = null;
    }
    const card = document.querySelector(".people-bar .engagement-card")?.dataset.card ?? "none";
    return { entries, card, holding: r.dataset.holding === "1", live: bar()?.dataset.live === "1" };
  };
  R.model = () => {
    const m = window.__faceRow?.read();
    if (!m) return null;
    return { entries: m.entries.map((e) => ({ id: e.id, state: e.state, tier: e.tier })), links: m.links, card: m.card.kind, room: m.room, me: !!m.me };
  };
  R.call = () => { const c = window.__inboxStore?.getState().call; return c ? { phase: c.phase, roomKey: c.roomKey } : null; };

  const byId = (s) => Object.fromEntries(s.entries.map((e) => [e.id, e]));
  const tag = () => { for (const el of document.querySelectorAll(".face-row [data-face-id]")) if (!el.__rigTag) el.__rigTag = el.dataset.faceId + "#" + R.seq++; };
  R.tick = () => {
    const s = R.snap();
    const t = now();
    const a = byId(R.last), b = byId(s);
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const from = a[id]?.state ?? "absent", to = b[id]?.state ?? "absent";
      if (from !== to) R.log.push({ t, id, from, to });
      const lf = a[id]?.link ?? null, lt = b[id]?.link ?? null;
      if (lf !== lt) R.log.push({ t, id, link: lt });
    }
    if (R.last.card !== s.card) R.log.push({ t, card: s.card });
    if (R.last.live !== s.live) R.log.push({ t, live: s.live });
    R.last = s;
    tag();
  };
  R.start = (label, t0) => {
    R.stop?.();
    R.t0 = t0 ?? Date.now();
    R.label = label;
    R.log = [];
    R.last = R.snap();
    tag();
    R.log.push({ t: now(), init: R.last });
    R.mo = new MutationObserver(R.tick);
    R.mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "data-link-kind", "data-card", "data-holding", "data-live", "data-face-id"] });
    R.stop = () => {
      R.mo.disconnect();
      R.tick();
      R.stop = null;
      const identity = [...document.querySelectorAll(".face-row [data-face-id]")].map((el) => ({ id: el.dataset.faceId, tag: el.__rigTag ?? null }));
      return { label: R.label, log: R.log, identity, final: R.last };
    };
    return R.last;
  };
  R.mark = (name) => { R.log.push({ t: now(), mark: name }); return Date.now(); };

  // ── drivers ──
  const seatOf = (id) => row()?.querySelector('[data-face-id="' + id + '"]');
  const settle = (pred, ms = 1500) => new Promise((res, rej) => {
    const t0 = Date.now();
    const poll = () => { const v = pred(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("nothing appeared")); requestAnimationFrame(poll); };
    poll();
  });
  // React renders the popover after the click's event, on its own tick, so
  // the drivers wait a frame or two for the buttons rather than reading the
  // DOM the click just left.
  // The one card under a face (F8): a click on the face pins it, and Talk,
  // Ring and Message live in it, in the band under the row. Escape closes it
  // again, so a leg's screenshots show the row and the engagement card alone.
  const cardOf = (id) => (seatOf(id)?.dataset.card === "1" ? row()?.querySelector(".face-row-below .face-card[data-member-card]") : null);
  R.openFace = async (id) => {
    const seat = seatOf(id);
    const hit = seat?.querySelector("[data-face-hit]");
    if (!hit) throw new Error("no face " + id);
    if (hit.getAttribute("aria-expanded") !== "true") hit.click();
    return settle(() => cardOf(id)?.querySelector(".face-actions")).catch(() => { throw new Error("the card never opened on " + id); });
  };
  R.closeCard = async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(() => !row()?.querySelector(".face-card[data-member-card]")).catch(() => {});
  };
  R.action = async (id, which) => {
    const actions = await R.openFace(id);
    const b = await settle(() => actions.querySelector(".face-action-" + which)).catch(() => { throw new Error(which + " is not offered on " + id); });
    if (b.disabled) throw new Error(which + " is disabled: " + (actions.querySelector(".face-actions-reason")?.textContent || b.title));
    const word = b.querySelector(".face-action-word")?.textContent ?? which;
    b.click();
    await R.closeCard();
    return word;
  };
  R.card = (action) => {
    const b = document.querySelector('.people-bar [data-card-action="' + action + '"]');
    if (!b) throw new Error("no card action " + action + " (card is " + (R.snap().card) + ")");
    b.click();
    return true;
  };
  R.waitFor = (src, timeoutMs = 15000) => {
    const fn = new Function("s", "m", "c", "return (" + src + ")");
    const t0 = Date.now();
    return new Promise((res, rej) => {
      const poll = () => {
        let ok = false;
        try { ok = fn(R.snap(), R.model(), R.call()); } catch (e) { ok = false; }
        if (ok) return res(Date.now() - t0);
        if (Date.now() - t0 > timeoutMs) return rej(new Error("timeout waiting for " + src + " snap=" + JSON.stringify(R.snap()) + " call=" + JSON.stringify(R.call())));
        setTimeout(poll, 40);
      };
      poll();
    });
  };
  // Fault injection: LiveKit's own event, on the app's Room instance.
  R.livekit = (state) => { const r = window.__callManager?.room(); if (!r) throw new Error("no room"); r.emit("connectionStateChanged", state); return r.state; };
  return "installed";
})()
`;

/** Which states mean the face is engaged with the viewer (or in a call). */
export const ENGAGED = new Set(["talking-to-me", "hearing-me", "live-with-me", "joining", "speaking", "ringing-them", "ringing-me", "in-call"]);

/**
 * The seam assertion: a face's states across a leg never read engaged, then
 * presence (or absent), then engaged again. Returns the offending triples.
 */
export function offThenOn(log, id) {
  const seq = log.filter((e) => e.id === id && e.to !== undefined).map((e) => e.to);
  const init = log.find((e) => e.init)?.init?.entries.find((e) => e.id === id)?.state;
  const states = init ? [init, ...seq] : seq;
  const bad = [];
  let seenEngaged = false;
  let dipped = null;
  for (const s of states) {
    if (ENGAGED.has(s)) {
      if (seenEngaged && dipped) bad.push(`${dipped} between engaged states`);
      seenEngaged = true;
      dipped = null;
    } else if (seenEngaged) {
      dipped = dipped ?? s;
    }
  }
  return { states, bad };
}
