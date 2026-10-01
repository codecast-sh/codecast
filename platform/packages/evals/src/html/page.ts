/**
 * The page shell every HTML view shares: one self-contained file, no
 * network but the fonts, a dark stage the way a control room reads at
 * night, and a small script for the filters. The assistant is always the
 * mint accent and never a hue; people rotate through eight hues, the same
 * order the terminal uses, so a reader moving between the two keeps their
 * bearings.
 */

import type { Participant } from '../model';
import { assignHues } from '../story';

export const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** JSON inside a <script> tag: the one sequence that would end the tag early is escaped. */
export const jsonForScript = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

export const HUES = ['#7aa2ff', '#f5a97f', '#c792ea', '#89ddff', '#f28fad', '#a6da95', '#ffd166', '#8bd5ca'];
export const ACCENT = '#6ee7b7';

export function hueOf(participants: Participant[], id: string): string {
  const p = participants.find((x) => x.id === id);
  if (!p || p.role === 'assistant') return ACCENT;
  if (p.role === 'system') return '#6a7386';
  const i = assignHues(participants).get(id) ?? 0;
  return HUES[i % HUES.length]!;
}

export const hours = (ms: number): string => (ms < 48 * 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${(ms / 86_400_000).toFixed(1)}d`);
export const secs = (ms: number): string => (ms < 90_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 60_000).toFixed(1)}m`);
export const money = (usd: number): string => (usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);
export const clock = (iso: string): string => iso.slice(5, 16).replace('T', ' ');
export const dayOffset = (iso: string, start: string | null | undefined): string => {
  if (!start) return clock(iso);
  const minutes = Math.floor((Date.parse(iso) - Date.parse(start)) / 60_000);
  if (!Number.isFinite(minutes)) return clock(iso);
  const d = Math.floor(minutes / 1440);
  const m = minutes - d * 1440;
  return `${d < 0 ? `d${d}` : `d${String(d).padStart(2, '0')}`} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export const CSS = `
:root {
  --ink:#0b0d12; --stage:#12151c; --panel:#181c25; --panel-2:#1f2430; --line:#2a3040; --line-2:#343b4d;
  --text:#e8eaf0; --dim:#9aa3b5; --faint:#6a7386;
  --accent:${ACCENT}; --pass:#5ddc9a; --fail:#ff6b6b; --warn:#f5c451; --link:#7aa2ff;
  --mono:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans:'Instrument Sans', 'Helvetica Neue', system-ui, sans-serif;
}
* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { margin:0; background:var(--ink); color:var(--text); font-family:var(--sans); font-size:15px; line-height:1.55;
  background-image:radial-gradient(1000px 520px at 8% -10%, rgba(110,231,183,.08), transparent 60%),
                   radial-gradient(800px 420px at 100% 0%, rgba(122,162,255,.07), transparent 60%),
                   repeating-linear-gradient(0deg, transparent 0 39px, rgba(255,255,255,.015) 39px 40px); }
main { max-width:1180px; margin:0 auto; padding:40px 28px 140px; }
h1 { font-size:38px; letter-spacing:-.025em; margin:0 0 6px; font-weight:600; line-height:1.1; }
h2 { font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--faint); font-weight:600; margin:44px 0 14px;
  display:flex; align-items:center; gap:12px; }
h2::after { content:''; flex:1; height:1px; background:var(--line); }
h3 { font-size:20px; margin:0 0 4px; letter-spacing:-.01em; font-weight:600; }
p { margin:0 0 12px; } a { color:var(--link); text-decoration:none; } a:hover { text-decoration:underline; }
.lede { color:var(--dim); max-width:70ch; }
.mono { font-family:var(--mono); }
.tag { font-family:var(--mono); font-size:11px; letter-spacing:.06em; text-transform:uppercase; padding:2px 8px; border-radius:999px;
  border:1px solid var(--line-2); color:var(--dim); white-space:nowrap; }
.verdict { font-family:var(--mono); font-weight:600; letter-spacing:.1em; padding:4px 11px; border-radius:6px; font-size:12px; white-space:nowrap; }
.v-pass { background:rgba(93,220,154,.14); color:var(--pass); border:1px solid rgba(93,220,154,.35); }
.v-fail { background:rgba(255,107,107,.13); color:var(--fail); border:1px solid rgba(255,107,107,.35); }
.v-crash, .v-unscored, .v-running { background:rgba(245,196,81,.13); color:var(--warn); border:1px solid rgba(245,196,81,.35); }
.sticky { position:sticky; top:0; z-index:5; background:rgba(11,13,18,.9); backdrop-filter:blur(10px); border-bottom:1px solid var(--line);
  padding:10px 28px; font-family:var(--mono); font-size:12px; display:flex; gap:16px; align-items:center; overflow-x:auto; }
.sticky a { color:var(--dim); white-space:nowrap; } .sticky a:hover { color:var(--text); text-decoration:none; }
.sticky .spacer { flex:1; }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
.cell { background:var(--panel); padding:12px 14px; }
.cell .k { font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); }
.cell .v { font-family:var(--mono); font-size:20px; font-variant-numeric:tabular-nums; margin-top:3px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:0 0 12px; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th { text-align:left; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); font-weight:600; padding:0 10px 8px; border-bottom:1px solid var(--line); }
td { padding:9px 10px; border-bottom:1px solid rgba(42,48,64,.6); vertical-align:top; }
tr:last-child td { border-bottom:none; }
td.num, th.num { text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
/* cast */
.cast { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:10px; }
.who { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:12px 14px; border-left:3px solid var(--hue); position:relative; }
.who .name { font-weight:600; font-size:15px; display:flex; align-items:center; gap:8px; }
.who .name i { width:9px; height:9px; border-radius:50%; background:var(--hue); display:inline-block; box-shadow:0 0 0 3px color-mix(in srgb, var(--hue) 25%, transparent); }
.who .role { font-family:var(--mono); font-size:11px; color:var(--dim); margin-top:3px; text-transform:uppercase; letter-spacing:.08em; }
.who .meta { color:var(--dim); font-size:13px; margin-top:6px; }
.who .addr { font-family:var(--mono); font-size:11px; color:var(--faint); margin-top:4px; word-break:break-all; }
.who.assistant { background:linear-gradient(135deg, rgba(110,231,183,.09), var(--panel) 60%); }
/* timeline strip */
.strip { position:relative; height:64px; border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow:hidden; margin:0 0 6px; }
.strip .day { position:absolute; top:0; bottom:0; border-left:1px dashed var(--line-2); }
.strip .day span { position:absolute; top:4px; left:5px; font-family:var(--mono); font-size:10px; color:var(--faint); }
.strip .mark { position:absolute; width:8px; height:8px; border-radius:50%; background:var(--hue); transform:translate(-50%,-50%); cursor:default; }
.strip .mark.out { top:44px; } .strip .mark.in { top:26px; } .strip .mark.sys { top:56px; width:5px; height:5px; opacity:.6; }
.strip .mark.hollow { background:transparent; border:2px solid var(--hue); }
.strip .mark:hover { transform:translate(-50%,-50%) scale(1.6); z-index:2; }
.legend { font-family:var(--mono); font-size:11px; color:var(--faint); display:flex; gap:14px; margin:0 0 18px; }
/* story */
.chips { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 14px; }
.chip { font-family:var(--mono); font-size:11px; padding:3px 10px; border-radius:999px; border:1px solid var(--line-2); color:var(--dim); cursor:pointer; background:transparent; }
.chip.on { background:var(--text); color:var(--ink); border-color:var(--text); }
.chip:hover { border-color:var(--text); }
.story { display:flex; flex-direction:column; gap:10px; }
.msg { display:flex; gap:12px; align-items:flex-start; max-width:84%; }
.msg.out { align-self:flex-end; flex-direction:row-reverse; }
.msg .dot { width:10px; height:10px; border-radius:50%; background:var(--hue); margin-top:14px; flex:none; box-shadow:0 0 0 3px color-mix(in srgb, var(--hue) 22%, transparent); }
.bubble { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:10px 14px 11px; border-left:3px solid var(--hue); min-width:180px; }
.msg.out .bubble { border-left:1px solid var(--line); border-right:3px solid var(--accent); background:linear-gradient(135deg, rgba(110,231,183,.06), var(--panel) 70%); }
.bubble .head { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; font-family:var(--mono); font-size:11.5px; color:var(--dim); margin-bottom:5px; }
.bubble .head b { color:var(--hue); font-weight:600; font-size:12.5px; }
.msg.out .bubble .head b { color:var(--accent); }
.bubble .head .room { color:var(--warn); }
.bubble .head .st { color:var(--fail); }
.bubble .body { white-space:pre-wrap; font-size:14.5px; overflow-wrap:anywhere; }
.bubble .body.clamp { max-height:11.5em; overflow:hidden; position:relative; }
.bubble .body.clamp::after { content:''; position:absolute; left:0; right:0; bottom:0; height:3em; background:linear-gradient(transparent, var(--panel)); }
.bubble .more { font-family:var(--mono); font-size:11px; color:var(--link); cursor:pointer; margin-top:4px; }
.sys { align-self:center; font-family:var(--mono); font-size:12px; color:var(--faint); text-align:center; max-width:80%; padding:2px 12px; }
.sys.beat { color:var(--warn); border:1px dashed rgba(245,196,81,.35); border-radius:999px; padding:3px 12px; }
.sys.bad { color:var(--fail); }
.sys.silent { color:var(--dim); font-style:italic; }
.sys .t { color:var(--faint); margin-right:8px; font-style:normal; }
.frozen { align-self:stretch; text-align:center; font-family:var(--mono); font-size:12px; letter-spacing:.2em; color:var(--warn); border-top:2px dashed var(--warn); padding-top:6px; margin:10px 0; }
.day-h { align-self:stretch; font-family:var(--mono); font-size:11px; color:var(--faint); letter-spacing:.14em; text-transform:uppercase; margin:12px 0 2px; display:flex; align-items:center; gap:10px; }
.day-h::after { content:''; flex:1; height:1px; background:var(--line); }
/* rooms */
.rooms { display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:12px; }
.room { background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; border-top:3px solid var(--hue); }
.room .rh { padding:10px 14px; background:var(--panel-2); display:flex; gap:10px; align-items:center; font-size:14px; }
.room .rh .n { margin-left:auto; font-family:var(--mono); font-size:11px; color:var(--faint); }
.room .rb { padding:12px 14px; display:flex; flex-direction:column; gap:8px; }
.room .msg { max-width:96%; }
/* score */
.gate { border-left:3px solid var(--pass); }
.gate.bad { border-left-color:var(--fail); }
.gate.vac { border-left-color:var(--line-2); }
.bar { height:6px; border-radius:3px; background:var(--panel-2); overflow:hidden; display:inline-block; width:80px; vertical-align:middle; }
.bar > i { display:block; height:100%; background:var(--pass); }
.bar.low > i { background:var(--fail); } .bar.mid > i { background:var(--warn); }
details { margin-top:8px; } summary { cursor:pointer; color:var(--dim); font-size:13px; font-family:var(--mono); }
details pre, .log, pre.raw { background:var(--ink); border:1px solid var(--line); border-radius:8px; padding:12px; overflow-x:auto; font-family:var(--mono); font-size:12px; color:var(--dim); white-space:pre-wrap; margin:8px 0 0; overflow-wrap:anywhere; }
blockquote { margin:6px 0 6px 12px; padding-left:12px; border-left:2px solid var(--line-2); color:var(--dim); font-size:13.5px; white-space:pre-wrap; }
/* events */
.events { border:1px solid var(--line); border-radius:10px; max-height:520px; overflow:auto; background:var(--panel); }
.ev { display:flex; gap:10px; padding:5px 12px; border-bottom:1px solid rgba(42,48,64,.5); font-family:var(--mono); font-size:12px; cursor:pointer; align-items:baseline; }
.ev:hover { background:var(--panel-2); }
.ev .seq { color:var(--faint); width:44px; text-align:right; flex:none; }
.ev .at { color:var(--dim); width:74px; flex:none; }
.ev .k { padding:1px 7px; border-radius:4px; background:var(--panel-2); color:var(--dim); flex:none; font-size:11px; }
.ev .k.send_captured { color:var(--accent); } .ev .k.inbound_injected { color:var(--link); } .ev .k.boundary_blocked, .ev .k.job_failed { color:var(--fail); background:rgba(255,107,107,.12); }
.ev .k.persona_replied, .ev .k.persona_scheduled { color:#c792ea; } .ev .k.gate { color:var(--warn); }
.ev .s { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ev pre { display:none; width:100%; }
.ev.open { flex-wrap:wrap; } .ev.open pre { display:block; } .ev.open .s { white-space:normal; }
.spine { font-family:var(--mono); font-size:12px; color:var(--dim); }
.spine b { color:var(--text); font-weight:500; }
.hidden { display:none !important; }
.side { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:12px; }
.foot { font-family:var(--mono); font-size:11px; color:var(--faint); margin-top:40px; }
@media (max-width: 720px) { .msg { max-width:100%; } main { padding:24px 14px 100px; } h1 { font-size:28px; } }
`;

export const JS = `
(function(){
  function chips(root){
    var group = root.getAttribute('data-filter');
    var target = document.querySelectorAll('[data-lane-of="' + group + '"]');
    root.querySelectorAll('.chip').forEach(function(chip){
      chip.addEventListener('click', function(){
        root.querySelectorAll('.chip').forEach(function(c){ c.classList.remove('on'); });
        chip.classList.add('on');
        var want = chip.getAttribute('data-lane');
        target.forEach(function(el){
          var lanes = (el.getAttribute('data-lane') || '').split(' ');
          el.classList.toggle('hidden', want !== 'all' && lanes.indexOf(want) < 0);
        });
      });
    });
  }
  document.querySelectorAll('[data-filter]').forEach(chips);
  document.querySelectorAll('.more').forEach(function(m){
    m.addEventListener('click', function(){
      var body = m.previousElementSibling; body.classList.toggle('clamp');
      m.textContent = body.classList.contains('clamp') ? 'show all' : 'show less';
    });
  });
  document.querySelectorAll('.ev').forEach(function(ev){ ev.addEventListener('click', function(){ ev.classList.toggle('open'); }); });
})();
`;

export function shell(title: string, body: string, opts: { nav?: Array<[string, string]>; kicker?: string } = {}): string {
  const nav = opts.nav?.length
    ? `<div class="sticky">${opts.kicker ? `<span style="color:var(--text)">${esc(opts.kicker)}</span>` : ''}${opts.nav.map(([href, label]) => `<a href="${esc(href)}">${esc(label)}</a>`).join('')}<span class="spacer"></span></div>`
    : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head><body>${nav}<main>${body}</main><script>${JS}</script></body></html>`;
}

export const bar = (value: number): string =>
  `<span class="bar ${value < 0.5 ? 'low' : value < 0.8 ? 'mid' : ''}"><i style="width:${Math.round(Math.max(0, Math.min(1, value)) * 100)}%"></i></span>`;

export const verdictPill = (status: string, score: number | null): string =>
  `<span class="verdict v-${esc(status)}">${status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : status === 'crash' ? 'CRASHED' : status.toUpperCase()}${score !== null && (status === 'pass' || status === 'fail') ? ` ${score.toFixed(2)}` : ''}</span>`;

export const statGrid = (cells: Array<[string, string]>): string =>
  `<div class="grid">${cells.map(([k, v]) => `<div class="cell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>`;
