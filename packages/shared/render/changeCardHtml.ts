// The one renderer for a change card (the-line-end-to-end.md LE10): a whole,
// self-contained HTML page (no fonts, scripts or images fetched) that the CLI
// publishes onto the task and the web shows in the decision. Pure string
// building, so it runs in the CLI, the browser and a test alike.

import {
  proofSummary,
  honestChecks,
  riskLabel,
  verdictLabel,
  type CardCheck,
  type ChangeCard,
} from "../contracts/changeCard";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// UTC so a card renders the same wherever it is built.
const day = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

// A metric ref (in-2:dollars_per_intro) or a short id helps a reader find the
// goal; a raw document id beside the goal's own name does not.
const readableRef = (goal: { ref: string; name?: string }) => !goal.name || goal.ref.includes(":") || goal.ref.length < 20;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
export const formatUsd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US")}`;
export function formatMinutes(n: number): string {
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const ICON_OK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_BAD = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICON_ARROW = `<svg viewBox="0 0 24 12" aria-hidden="true"><path d="M1 6h20M16 1.5L21 6l-5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const mark = (ok: boolean) => `<span class="mark ${ok ? "ok" : "bad"}" title="${ok ? "passes" : "fails"}">${ok ? ICON_OK : ICON_BAD}</span>`;

function proofRows(card: ChangeCard): string {
  const after = new Map(card.proof.after.map((x) => [x.name, x]));
  const seen = new Set<string>();
  const rows: string[] = [];
  const row = (name: string, b: CardCheck | undefined, a: CardCheck | undefined) => {
    const pill = (x: CardCheck | undefined, side: string) =>
      x
        ? `<div class="pill ${x.ok ? "ok" : "bad"}">${mark(x.ok)}<span>${esc(x.detail || (x.ok ? "passes" : "fails"))}</span></div>`
        : `<div class="pill none"><span>not run ${side}</span></div>`;
    rows.push(`<li><div class="pname">${esc(name)}</div>${pill(b, "before")}<div class="arrow">${ICON_ARROW}</div>${pill(a, "after")}</li>`);
  };
  for (const b of card.proof.before) {
    seen.add(b.name);
    row(b.name, b, after.get(b.name));
  }
  for (const a of card.proof.after) if (!seen.has(a.name)) row(a.name, undefined, a);
  return rows.join("");
}

function beads(card: ChangeCard): string {
  const after = new Map(card.proof.after.map((x) => [x.name, x.ok]));
  return card.proof.before
    .map((b) => {
      const a = after.get(b.name);
      return `<span class="bead"><i class="${b.ok ? "ok" : "bad"}"></i><i class="${a === undefined ? "none" : a ? "ok" : "bad"}"></i></span>`;
    })
    .join("");
}

function examples(card: ChangeCard): string {
  if (!card.examples.length) return "";
  const items = card.examples
    .map(
      (ex, i) => `<article class="example">
  <div class="input"><span class="lbl">Example ${i + 1}</span><blockquote>${esc(ex.input)}</blockquote></div>
  <div class="pair">
    <div class="side before"><span class="lbl">Before</span><div class="reply">${esc(ex.before)}</div></div>
    <div class="side after"><span class="lbl">After</span><div class="reply">${esc(ex.after)}</div></div>
  </div>
  ${ex.note ? `<p class="note">${esc(ex.note)}</p>` : ""}
</article>`,
    )
    .join("\n");
  return `<section class="block"><h2>Before and after</h2>${items}</section>`;
}

function checksList(checks: CardCheck[]): string {
  if (!checks.length) return "";
  const rows = checks.map((c) => `<li>${mark(c.ok)}<span class="cname">${esc(c.name)}</span><span class="cdetail">${esc(c.detail)}</span></li>`).join("");
  return `<section class="block"><h2>Checks</h2><ul class="checks">${rows}</ul></section>`;
}

function diffPanel(card: ChangeCard): string {
  const { files, added, removed, pr } = card.diff;
  const total = added + removed;
  const addPct = total ? Math.max(4, Math.round((added / total) * 100)) : 0;
  const bar = total ? `<div class="dbar"><i class="add" style="width:${addPct}%"></i><i class="del" style="width:${100 - addPct}%"></i></div>` : "";
  const prLink = pr ? `<a href="${esc(pr)}">${esc(pr.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace("/pull/", "#"))}</a>` : `<span class="dim">no pull request</span>`;
  return `<div class="panel"><h3>Diff</h3><div class="big num">${files} <small>${files === 1 ? "file" : "files"}</small></div>
<div class="num delta"><span class="add">+${added}</span> <span class="del">&minus;${removed}</span></div>${bar}<div class="sub">${prLink}</div></div>`;
}

const CSS = `
:root{
  --bg:#eef1ee; --paper:#fbfcfa; --ink:#18211d; --muted:#5b6862; --faint:#8b9792; --rule:#dde3df;
  --red:#c2412d; --red-soft:#f8e5df; --green:#17845a; --green-soft:#dcf1e6; --blue:#2f5fb3; --blue-soft:#e2eaf8;
  --neutral:#5b6862; --neutral-soft:#e4e9e6;
  --sans:"Avenir Next","Seravek","Segoe UI Variable Text","Ubuntu","Helvetica Neue",sans-serif;
  --mono:"JetBrains Mono","SF Mono","Cascadia Code",ui-monospace,Menlo,monospace;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0c1311; --paper:#121b18; --ink:#e3ebe7; --muted:#9aa9a2; --faint:#6c7a74; --rule:#23302b;
  --red:#ff8a73; --red-soft:#3a1d18; --green:#5fd4a2; --green-soft:#12301f; --blue:#8fb2f2; --blue-soft:#18233a;
  --neutral:#9aa9a2; --neutral-soft:#1b2622;
}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;font:16px/1.55 var(--sans);color:var(--ink);-webkit-font-smoothing:antialiased;
  background:radial-gradient(1200px 380px at 50% -120px,var(--tone-soft),transparent 70%) no-repeat,var(--bg)}
main{max-width:880px;margin:0 auto;padding:40px 24px 64px}
.sheet{background:var(--paper);border:1px solid var(--rule);border-radius:18px;padding:36px 40px;box-shadow:0 1px 0 var(--rule),0 24px 48px -32px rgba(0,0,0,.25)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;font-size:13.5px;color:var(--muted)}
.verdict{display:inline-flex;align-items:center;gap:8px;font-weight:650;color:var(--tone);background:var(--tone-soft);padding:4px 12px 4px 10px;border-radius:999px}
.verdict::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--tone)}
.task{font-family:var(--mono);font-size:12.5px;color:var(--ink)}
.risk{margin-left:auto;font-weight:600;color:var(--ink);border:1px solid var(--rule);padding:3px 10px;border-radius:8px}
h1{font-size:30px;line-height:1.2;font-weight:700;letter-spacing:-.015em;margin:18px 0 10px}
.context{font-size:18px;line-height:1.45;margin:0 0 12px;max-width:62ch}
.goal{color:var(--muted);margin:0}
.goal b{color:var(--ink);font-weight:600}
.why{margin:6px 0 0;color:var(--muted);font-size:15px;max-width:62ch}
.big.mid{font-size:18px}
.goal code{font:12px var(--mono);background:var(--bg);border:1px solid var(--rule);padding:1px 6px;border-radius:6px;margin-left:4px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:28px 0 8px}
.say{border-radius:12px;padding:16px 18px;background:var(--bg)}
.say .lbl{display:block;font-size:13px;font-weight:650;margin-bottom:4px}
.say.wrong .lbl{color:var(--red)} .say.change .lbl{color:var(--green)}
.say p{margin:0;font-size:17px;line-height:1.5}
.block{margin-top:32px}
h2{font-size:15px;font-weight:650;margin:0 0 12px;display:flex;align-items:baseline;gap:12px}
h2 .count{font-weight:500;color:var(--muted);font-size:14px}
h3{font-size:13px;font-weight:650;color:var(--muted);margin:0 0 6px}
.lbl{font-size:12.5px;font-weight:650;color:var(--muted)}
.dim{color:var(--faint)}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.mark{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;flex:none}
.mark svg{width:13px;height:13px}
.mark.ok{color:var(--green);background:var(--green-soft)} .mark.bad{color:var(--red);background:var(--red-soft)}
.beads{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.bead{display:inline-flex;border-radius:6px;overflow:hidden;box-shadow:0 0 0 1px var(--rule)}
.bead i{width:16px;height:12px} .bead i.ok{background:var(--green)} .bead i.bad{background:var(--red)} .bead i.none{background:var(--rule)}
.proof{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.proof li{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) 28px minmax(0,1fr);align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--rule)}
.pname{font-size:14.5px;font-weight:550;overflow-wrap:anywhere}
.pill{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;font-size:13px;line-height:1.35;min-width:0}
.pill span{overflow-wrap:anywhere}
.pill.ok{background:var(--green-soft)} .pill.bad{background:var(--red-soft)} .pill.none{background:var(--bg);color:var(--faint)}
.arrow{color:var(--faint);display:grid;place-items:center} .arrow svg{width:24px;height:12px}
.example{border:1px solid var(--rule);border-radius:14px;padding:16px;margin-bottom:14px;break-inside:avoid}
.example blockquote{margin:6px 0 14px;padding:10px 14px;background:var(--bg);border-radius:10px;font-size:14.5px;white-space:pre-wrap;overflow-wrap:anywhere}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.side{border-radius:10px;padding:10px 14px;border-top:3px solid}
.side.before{border-color:var(--red);background:color-mix(in srgb,var(--red-soft) 55%,transparent)}
.side.after{border-color:var(--green);background:color-mix(in srgb,var(--green-soft) 55%,transparent)}
.reply{margin-top:4px;font-size:14.5px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:15.5em;overflow:auto}
.note{margin:12px 2px 0;font-size:14px;color:var(--muted)}
.checks{list-style:none;margin:0;padding:0}
.checks li{display:grid;grid-template-columns:20px 110px 1fr;gap:12px;align-items:start;padding:8px 0;border-bottom:1px solid var(--rule);font-size:14.5px}
.cname{font-weight:600} .cdetail{color:var(--muted);overflow-wrap:anywhere}
.panels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:32px}
.panel{background:var(--bg);border-radius:12px;padding:14px 16px}
.big{font-size:24px;font-weight:600;line-height:1.2} .big small{font-size:13px;color:var(--muted);font-family:var(--sans);font-weight:500}
.delta{font-size:13.5px;margin-top:2px} .delta .add{color:var(--green)} .delta .del{color:var(--red)}
.dbar{display:flex;height:6px;border-radius:3px;overflow:hidden;margin:8px 0 6px;gap:2px}
.dbar .add{background:var(--green)} .dbar .del{background:var(--red)}
.sub{font-size:13px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}
.sub a{color:var(--blue);text-decoration:none;font-family:var(--mono);font-size:12.5px}
.costs{display:flex;flex-direction:column;gap:2px;font-size:14px}
.costs .num{font-size:15px;color:var(--ink)}
.rec{margin-top:28px;border-radius:14px;padding:18px 20px;background:var(--tone-soft);display:flex;gap:16px;align-items:baseline}
.rec .word{font-size:22px;font-weight:700;color:var(--tone);flex:none}
.rec p{margin:0;font-size:16px}
footer{margin-top:18px;text-align:center;font-size:12.5px;color:var(--faint)}
@media (max-width:640px){
  main{padding:16px 10px 40px} .sheet{padding:22px 18px;border-radius:14px}
  h1{font-size:24px} .two,.pair,.panels{grid-template-columns:1fr} .risk{margin-left:0}
  .proof li{grid-template-columns:1fr 24px 1fr} .pname{grid-column:1/-1}
  .checks li{grid-template-columns:20px 1fr} .cdetail{grid-column:2}
  .rec{flex-direction:column;gap:4px}
}
@media print{
  :root{--bg:#f2f4f2;--paper:#fff;--ink:#111;--muted:#4a5550;--faint:#7a8580;--rule:#d5dbd7;
    --red:#b3361f;--red-soft:#f8e3dc;--green:#11744d;--green-soft:#dcf0e4;--blue:#2a56a3;--blue-soft:#e2eaf8}
  html,body{background:#fff} body{font-size:11pt}
  main{max-width:none;padding:0} .sheet{border:0;box-shadow:none;padding:0}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .reply{max-height:none;overflow:visible} .block,.panels,.rec,.proof li{break-inside:avoid}
  footer{display:none}
}`;

/** The change card as one self-contained HTML page. */
export function renderChangeCardHtml(card: ChangeCard): string {
  const proof = proofSummary(card.proof);
  const v = card.recommend.verdict;
  const tone = v === "ship" ? "green" : v === "revise" ? "blue" : v === "drop" ? "red" : "neutral";
  const recommends = tone === "neutral" ? verdictLabel(v) : `Recommends ${verdictLabel(v)}`;
  const c = card.cause;
  const signals = c.signals
    ? `<span>${c.signals} ${c.signals === 1 ? "signal" : "signals"}${c.first_seen ? ` since ${day(c.first_seen)}` : ""}</span>`
    : "";
  const sources = c.sources.length ? `<span>${c.sources.map(esc).join(", ")}</span>` : "";
  const goal =
    card.goal.ref === "none"
      ? `<p class="goal">Serves no named goal.</p>`
      : `<p class="goal" title="${esc(card.goal.why)}">Serves <b>${esc(card.goal.name || card.goal.ref)}</b>${readableRef(card.goal) ? `<code>${esc(card.goal.ref)}</code>` : ""}</p>${card.goal.why && !card.headline ? `<p class="why">${esc(card.goal.why)}</p>` : ""}`;
  const proofBlock = card.proof.before.length || card.proof.after.length
    ? `<section class="block"><h2>Proof <span class="count">${esc(proof.evidence)}</span></h2><div class="beads" aria-hidden="true">${beads(card)}</div><ul class="proof">${proofRows(card)}</ul></section>`
    : `<section class="block"><h2>Proof <span class="count">none recorded</span></h2></section>`;
  const { tokens, usd, minutes } = card.cost;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`Change card: ${c.title}`)}</title>
<style>${CSS}
:root{--tone:var(--${tone});--tone-soft:var(--${tone}-soft)}</style>
</head>
<body>
<main>
<div class="sheet">
<header>
  <div class="meta"><span class="verdict">${recommends}</span><span class="task">${esc(c.task)}</span>${signals}${sources}<span class="risk">${esc(riskLabel(card.risk))}</span></div>
  <h1>${esc(card.headline || c.title)}</h1>
  ${card.context ? `<p class="context">${esc(card.context)}</p>` : ""}
  ${goal}
</header>
<div class="two">
  <div class="say wrong"><span class="lbl">What is wrong</span><p>${esc(card.wrong)}</p></div>
  <div class="say change"><span class="lbl">What this changes</span><p>${esc(card.change)}</p></div>
</div>
${proofBlock}
${examples(card)}
${checksList(honestChecks(card.checks))}
<div class="panels">
  ${diffPanel(card)}
  <div class="panel"><h3>Risk</h3><div class="big mid">${esc(riskLabel(card.risk))}</div><div class="sub">${esc(card.risk.reason)}</div></div>
  <div class="panel"><h3>Cost</h3><div class="costs"><span><span class="num">${formatUsd(usd)}</span></span><span><span class="num">${formatTokens(tokens)}</span> tokens</span><span><span class="num">${formatMinutes(minutes)}</span> of agent time</span></div></div>
</div>
<div class="rec"><span class="word">${verdictLabel(card.recommend.verdict)}</span><p>${esc(card.recommend.why)}</p></div>
</div>
<footer>Change card for ${esc(c.task)}</footer>
</main>
</body>
</html>
`;
}
