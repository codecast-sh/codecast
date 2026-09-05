// Builds index.html from chapter markdown (c01.md ...) and figures.html templates.
// Reuses the v1 pipeline shape: marked from the repo's bun store, placeholders <!-- FIGURE:name -->.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(dir, '../../../../node_modules/.bun');
const packageName = fs.readdirSync(modules).find(name => /^marked@/.test(name));
if (!packageName) throw new Error('Install the repository dependencies before building this proposal.');
const { marked } = await import(pathToFileURL(path.join(modules, packageName, 'node_modules/marked/lib/marked.esm.js')).href);

const css = fs.readFileSync(path.join(dir, 'base.css'), 'utf8');
const figures = fs.readFileSync(path.join(dir, 'figures.html'), 'utf8');
const blocks = Object.fromEntries([...figures.matchAll(/<template id="([^"]+)">([\s\S]*?)<\/template>/g)].map(m => [m[1], m[2]]));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

const chapterFiles = fs.readdirSync(dir).filter(f => /^c\d\d\.md$/.test(f)).sort();
const sections = [];
const toc = [];
for (const [index, filename] of chapterFiles.entries()) {
  const i = index + 1;
  const level = meta.levels[index] || 'session';
  let content = marked.parse(fs.readFileSync(path.join(dir, filename), 'utf8'));
  let h = 0;
  let title = '';
  content = content.replace(/<h([234])>([\s\S]*?)<\/h\1>/g, (_, lvl, text) => {
    const id = lvl === '2' ? `s${i}` : `s${i}-${++h}`;
    if (lvl === '2') { title = text.replace(/^\d+\.\s*/, ''); toc.push({ id, title, level }); return `<h2 id="${id}" tabindex="-1"><span class="chapter-num" aria-hidden="true">${String(i).padStart(2, '0')}</span>${title}</h2>`; }
    return `<h${lvl} id="${id}" tabindex="-1">${text}</h${lvl}>`;
  });
  content = content.replace(/<!--\s*(FIGURE|MOCKUP):([\w-]+)\s*-->/g, (_, kind, key) => {
    const name = `${kind.toLowerCase()}-${key}`;
    if (!blocks[name]) throw new Error(`Missing figure ${name}`);
    return blocks[name];
  });
  content = content.replace(/<pre>/g, '<pre tabindex="0">');
  let tableNumber = 0;
  content = content.replace(/<table([^>]*)>/g, (_, attrs) => `<div class="table-scroll" tabindex="0" role="region" aria-label="Chapter ${i}, table ${++tableNumber}"><table${attrs}>`).replace(/<\/table>/g, '</table></div>');
  sections.push(`<section class="chapter" data-level="${level}" aria-labelledby="s${i}">${content}</section>`);
}
const nav = toc.map((x, n) => `<li data-level="${x.level}"><a href="#${x.id}"><span class="n">${String(n + 1).padStart(2, '0')}</span>${x.title}</a></li>`).join('');
const hero = blocks['figure-hero'] || '';

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${meta.title}</title>
<meta name="description" content="${meta.description}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body>
<a class="skip-link" href="#content">Skip to proposal</a>
<div class="page">
<aside class="rail">
<a class="brand" href="#top"><span class="brand-mark" aria-hidden="true"></span>codecast <span>proposal</span></a>
<nav class="toc toc-wide" aria-label="Contents"><ol>${nav}</ol></nav>
<div class="rail-legend" aria-label="Level colours">
<span data-level="workspace">Workspace</span><span data-level="project">Project</span><span data-level="plan">Plan</span><span data-level="task">Task</span><span data-level="session">Session</span>
</div>
<div class="rail-note">${meta.railNote}</div>
</aside>
<main id="content">
<header id="top" class="hero">
<p class="kicker reveal" style="--i:0">${meta.kicker}</p>
<h1 class="reveal" style="--i:1">${meta.headline}</h1>
<p class="dek reveal" style="--i:2">${meta.dek}</p>
${hero}
<div class="reading-paths reveal" style="--i:4">${meta.paths.map(p => `<a href="#${p.id}"><b>${p.label}</b><span>${p.note}</span></a>`).join('')}</div>
</header>
<details class="toc toc-narrow"><summary>Contents · ${toc.length} chapters</summary><ol>${nav}</ol></details>
${sections.join('\n')}
<footer class="proposal-footer"><b>${meta.footerTitle}</b><span>${meta.footerNote}</span><a href="#top">Back to top</a></footer>
</main>
</div>
</body>
</html>`;
fs.writeFileSync(path.join(dir, 'index.html'), page);
console.log(JSON.stringify({ file: path.join(dir, 'index.html'), bytes: Buffer.byteLength(page), chapters: toc.length }));
