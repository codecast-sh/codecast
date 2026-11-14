/**
 * The parity report as one self-contained HTML page: a count per outcome up
 * top, then each area as a table where every item that did not make it shows
 * its reason and its fix, and grouped items open to every path they stand
 * for. The status buttons filter the rows.
 */

import { AREA_TITLES, type ParityItem, type ParityReport, type ParityStatus } from "./parity.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STATUS_LABEL: Record<ParityStatus, string> = {
  planned: "Will carry", carried: "Carried", installed: "Installed", present: "Present", skipped: "Skipped", failed: "Failed",
};

function row(i: ParityItem): string {
  const paths = i.paths?.length
    ? `<details><summary>${i.paths.length} path${i.paths.length === 1 ? "" : "s"}</summary><ul>${i.paths.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></details>`
    : "";
  return `<tr data-status="${i.status}"><td><span class="st st-${i.status}">${STATUS_LABEL[i.status]}</span></td>`
    + `<td class="name">${esc(i.name)}${i.detail ? `<div class="detail">${esc(i.detail)}</div>` : ""}</td>`
    + `<td>${i.reason ? `<div class="reason">${esc(i.reason)}</div>` : ""}${i.fix ? `<div class="fix"><code>${esc(i.fix)}</code></div>` : ""}${paths}</td></tr>`;
}

export function renderParityHtml(r: ParityReport): string {
  const statuses: ParityStatus[] = r.dry_run ? ["planned", "skipped"] : ["carried", "installed", "present", "skipped", "failed"];
  const areas = [...new Set(r.items.map((i) => i.area))];
  const title = r.dry_run ? `cast cloud dry run: ${r.laptop}` : `cast cloud: ${r.laptop} → ${r.target}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Martian+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#eef1ec;--card:#fbfcfa;--ink:#17201b;--dim:#5d6a62;--line:#d5dcd5;--carried:#1f7a4d;--installed:#1d6b8f;--present:#4f6b5a;--planned:#1d6b8f;--skipped:#a8650f;--failed:#c0362c}
*{box-sizing:border-box}body{margin:0;background:var(--bg) radial-gradient(circle at 1px 1px,#d9e0d8 1px,transparent 0) 0 0/18px 18px;color:var(--ink);font:15px/1.5 "Atkinson Hyperlegible",ui-sans-serif,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 20px 80px}
h1{font:600 20px/1.3 "Martian Mono",ui-monospace,monospace;margin:0 0 4px}.when{color:var(--dim);font-size:13px}
.counts{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 28px}
.counts button{all:unset;cursor:pointer;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:112px}
.counts button[aria-pressed=true]{outline:2px solid var(--ink)}
.counts b{display:block;font:600 26px/1.1 "Martian Mono",monospace}.counts span{font-size:13px;color:var(--dim)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 18px;overflow:hidden;animation:in .35s ease both}
section:nth-of-type(2){animation-delay:.04s}section:nth-of-type(3){animation-delay:.08s}section:nth-of-type(n+4){animation-delay:.12s}
@keyframes in{from{opacity:0;transform:translateY(6px)}}
h2{font:600 14px/1 "Martian Mono",monospace;margin:0;padding:14px 16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}
h2 small{font:400 12px "Atkinson Hyperlegible";color:var(--dim)}
table{width:100%;border-collapse:collapse}td{padding:9px 16px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
td:first-child{width:108px}.name{width:36%;word-break:break-word;font-family:"Martian Mono",monospace;font-size:12.5px}
.detail{font-family:"Atkinson Hyperlegible";color:var(--dim);font-size:13px}.reason{font-size:14px}
.fix code{font:12px "Martian Mono",monospace;background:#e7ece6;padding:2px 6px;border-radius:5px;display:inline-block;margin-top:4px}
.st{font:600 11px/1 "Martian Mono",monospace;padding:4px 7px;border-radius:5px;color:#fff;white-space:nowrap}
${(["carried", "installed", "present", "planned", "skipped", "failed"] as const).map((s) => `.st-${s}{background:var(--${s})}`).join("")}
details{margin-top:4px;font-size:13px}summary{cursor:pointer;color:var(--dim)}ul{margin:6px 0 0;padding-left:18px;font:12px/1.6 "Martian Mono",monospace;max-height:320px;overflow:auto}
tr.hide,section.hide{display:none}
section.first{border-color:var(--failed)}section.first h2{color:var(--failed)}
.scope{color:var(--dim);font-size:13px;margin-top:28px}.scope li{margin:2px 0}
</style></head><body><main>
<h1>${esc(title)}</h1><div class="when">${esc(new Date(r.created_at).toLocaleString())}</div>
<div class="counts">${statuses.map((s) => `<button data-filter="${s}" aria-pressed="false"><b style="color:var(--${s})">${r.counts[s]}</b><span>${STATUS_LABEL[s]}</span></button>`).join("")}</div>
${(() => {
    const failed = r.items.filter((i) => i.status === "failed");
    return failed.length ? `<section class="first"><h2>Failed<small>${failed.length}, from every area below</small></h2><table>${failed.map((i) => row({ ...i, name: `${AREA_TITLES[i.area]}: ${i.name}` })).join("")}</table></section>` : "";
  })()}
${areas.map((a) => {
    const items = r.items.filter((i) => i.area === a);
    const gaps = items.filter((i) => i.status === "skipped" || i.status === "failed").length;
    return `<section><h2>${esc(AREA_TITLES[a])}<small>${items.length - gaps} ok${gaps ? ` · ${gaps} not` : ""}</small></h2><table>${items.map(row).join("")}</table></section>`;
  }).join("\n")}
<ul class="scope">${r.scope.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
</main><script>
let on=null;for(const b of document.querySelectorAll("[data-filter]"))b.onclick=()=>{on=on===b.dataset.filter?null:b.dataset.filter;
for(const x of document.querySelectorAll("[data-filter]"))x.setAttribute("aria-pressed",String(x.dataset.filter===on));
for(const tr of document.querySelectorAll("tr[data-status]"))tr.classList.toggle("hide",!!on&&tr.dataset.status!==on);
for(const s of document.querySelectorAll("section"))s.classList.toggle("hide",!s.querySelector("tr[data-status]:not(.hide)"))};
</script></body></html>
`;
}
