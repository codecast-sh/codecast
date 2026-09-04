import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(dir, '../../../node_modules/.bun');
const packageName = fs.readdirSync(modules).find(name => /^marked@/.test(name));
if (!packageName) throw new Error('Install the repository dependencies before building this proposal.');
const { marked } = await import(pathToFileURL(path.join(modules, packageName, 'node_modules/marked/lib/marked.esm.js')).href);
const css = fs.readFileSync(path.join(dir, 'base.css'), 'utf8');
const figures = fs.readFileSync(path.join(dir, 'figures.html'), 'utf8');
const blocks = Object.fromEntries([...figures.matchAll(/<template id="([^"]+)">([\s\S]*?)<\/template>/g)].map(m => [m[1], m[2]]));
const sections = [];
const toc = [];
for (let i=1;i<=10;i++) {
  const filename=path.join(dir, `s${String(i).padStart(2,'0')}.md`);
  if (!fs.existsSync(filename)) throw new Error(`Missing ${filename}`);
  let content=marked.parse(fs.readFileSync(filename, 'utf8'));
  let h=0;
  content=content.replace(/<h([234])>([\s\S]*?)<\/h\1>/g, (_,level,title) => {
    const id=level==='2' ? `s${i}` : `s${i}-${++h}`;
    if(level==='2') toc.push({id,title:title.replace(/^\d+\.\s*/, '')});
    return `<h${level} id="${id}" tabindex="-1">${title}</h${level}>`;
  });
  content=content.replace(/<!--\s*(FIGURE|MOCKUP):([\w-]+)\s*-->/g, (_,kind,key) => {
    const name=`${kind.toLowerCase()}-${key}`;
    if(!blocks[name]) throw new Error(`Missing figure ${name}`);
    return blocks[name];
  });
  content=content.replace(/<pre>/g, '<pre tabindex="0">');
  let tableNumber=0;
  content=content.replace(/<table([^>]*)>/g, (_,attrs)=>`<div class="table-scroll" tabindex="0" role="region" aria-label="Chapter ${i}, table ${++tableNumber}: scroll for more columns"><table${attrs}>`).replace(/<\/table>/g,'</table></div>');
  sections.push(`<section class="section">${content}</section>`);
}
const nav=toc.map(x=>`<li><a href="#${x.id}">${x.title}</a></li>`).join('');
const extra=fs.readFileSync(path.join(dir,'polish.css'),'utf8');
const page=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Organization · Codecast product proposal</title><meta name="description" content="A detailed proposal for scoped agent leads, task execution, chat intake, evidence, authority and a measured rollout in Codecast."><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"><style>${css}\n${extra}</style></head><body><a class="skip-link" href="#content">Skip to proposal</a><div class="page"><aside class="rail"><a class="brand" href="#top">codecast <span>/ proposal</span></a><nav class="toc toc-wide" aria-label="Contents"><ol>${nav}</ol></nav><div class="rail-note">Prepared 4 September 2026<br>Product direction + engineering plan<br><a href="#s9">Rollout and choices ↗</a></div></aside><main id="content"><header id="top" class="title-block"><p class="date reveal" style="--i:0">A proposal for codecast · 4 September 2026</p><h1 class="reveal" style="--i:0">Agent<br>Organization</h1><p class="dek reveal" style="--i:1">Give every level of work a lead who can explain it, move it forward, and bring the right decisions to you.</p><div class="hero-summary reveal" style="--i:2"><b>Start with one useful project lead.</b><p>Connect approved work, preserve human ownership, and show the evidence behind every report. Add layers when they reduce coordination work.</p><span class="status-note">Proposed product · no feature deployment · examples are illustrative</span></div><div class="reading-paths"><a href="#s1">The recommendation <span>01</span></a><a href="#s7">The experience <span>07</span></a><a href="#s3">The engineering <span>03</span></a><a href="#s9">The build plan <span>09</span></a></div></header><details class="toc toc-narrow"><summary>Contents · 10 chapters</summary><ol>${nav}</ol></details>${sections.join('\n')}<footer class="proposal-footer"><b>Agent Organization</b><span>Research, decisions, interface concepts and a testable implementation plan.</span><a href="#top">Back to top ↑</a></footer></main></div></body></html>`;
fs.writeFileSync(path.join(dir,'index.html'),page);
console.log(JSON.stringify({file:path.join(dir,'index.html'),bytes:Buffer.byteLength(page),chapters:toc.length}));
