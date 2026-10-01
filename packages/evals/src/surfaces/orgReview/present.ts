import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CheckResult, Score } from '@platform/evals';

import { runAgent } from '../../adapters/dryRun';
import { scoreOf } from '../../adapters/replay';
import { legacyFile } from '../../commands/snapshot';
import { JUDGE_MODEL } from '../../models';
import { REPO_ROOT } from '../../paths';
import { refuseArchive, snapshotsRoot, snapshotWorkspace, tryJson } from './grade';

// Presentation, attended only: paint a run's proposal.json on the real
// proposal page (the DEV preview on localhost:3200, in the founder's Chrome)
// and capture desktop, the first ask's fold, "Ask about this", phone width,
// the chart and the chart fitted (the port of capture.sh, capture-raw.ts and
// chart-fit.ts, driven over the raw bridge websocket because the CLI's attach
// stalls under load). Then a judge reads the captures against the rubric in
// docs/architecture/org-eval.md, read at run time so it has one home, and
// writes one `presentation:<line>` check per rubric line into score.json.

export const DEV_URL = 'http://localhost:3200';
export const BRIDGE_FILE = join(homedir(), '.codecast', 'browser', 'bridge.json');
export const RUBRIC_DOC = join(REPO_ROOT, 'docs', 'architecture', 'org-eval.md');
const PREVIEW = `${DEV_URL}/org?preview=1`;
/** The product's tour layer and Tours panel (packages/web/tours): never part of what a capture grades. */
const TOUR_UI = '[data-tour-open],[data-tours-panel]';
const SHOTS = ['desktop', 'fold', 'ask', 'phone', 'chart', 'chart-fit'] as const;

/** One line naming what is missing, or null when the dev server and the founder's Chrome both answer. */
export async function presentationRefusal(o: { url?: string; bridgeFile?: string } = {}): Promise<string | null> {
  const url = o.url ?? DEV_URL;
  const bridgeFile = o.bridgeFile ?? BRIDGE_FILE;
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    return `presentation capture needs the web dev server: nothing answers on ${url} (start it with bun run dev)`;
  }
  if (!existsSync(bridgeFile)) return `presentation capture needs the founder's Chrome with the codecast extension: no ${bridgeFile} (cast browser extension status)`;
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const b = JSON.parse(readFileSync(bridgeFile, 'utf8')) as { port: number; token: string };
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}/devtools/browser/${b.token}`);
      const t = setTimeout(() => (ws.close(), resolve(false)), 5000);
      ws.onopen = () => (clearTimeout(t), ws.close(), resolve(true));
      ws.onerror = () => (clearTimeout(t), resolve(false));
    } catch {
      resolve(false);
    }
  });
  return ok ? null : `presentation capture needs the founder's Chrome: the browser bridge in ${bridgeFile} does not answer (cast browser extension status)`;
}

/** The numbered lines under "## Presentation rubric", continuation lines joined. */
export function parseRubric(md: string): Array<{ n: number; text: string }> {
  const start = md.indexOf('## Presentation rubric');
  if (start < 0) throw new Error(`${RUBRIC_DOC} has no "## Presentation rubric" section`);
  const rest = md.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  const lines: Array<{ n: number; text: string }> = [];
  for (const l of end < 0 ? rest : rest.slice(0, end)) {
    const m = /^(\d+)\.\s+(.*)$/.exec(l);
    if (m) lines.push({ n: Number(m[1]), text: m[2]!.trim() });
    else if (l.trim() && lines.length) lines[lines.length - 1]!.text += ` ${l.trim()}`;
  }
  return lines;
}

/** The judge's verdict: the last JSON object in what it said, one 0..3 score per rubric line. */
export function parseVerdict(said: string[], rubric: Array<{ n: number; text: string }>): CheckResult[] {
  const text = said.join('\n');
  const at = text.lastIndexOf('{"lines"');
  const json = at >= 0 ? text.slice(at, text.lastIndexOf('}') + 1) : '';
  let lines: Array<{ n: number; score: number; reasoning?: string }> = [];
  try {
    lines = (JSON.parse(json) as { lines: typeof lines }).lines;
  } catch {
    throw new Error(`the presentation judge returned no {"lines": [...]} verdict: ${text.slice(-300)}`);
  }
  return rubric.map((r) => {
    const v = lines.find((l) => Number(l.n) === r.n);
    const score = v ? Math.max(0, Math.min(3, Number(v.score))) : 0;
    return { id: `presentation:${r.n}`, ask: r.text, weight: 1, score: score / 3, reasoning: v?.reasoning ?? 'the judge did not grade this line' };
  });
}

/**
 * The snapshot a run read. A replay's hashes.json names the snapshot itself
 * (served is its dir name, workspace beside it); an old round's names its
 * served dir, which a snapshot keeps as the suffix of <ws>-<served>.
 */
export function runSnapshotDir(runDir: string): string | null {
  const h = tryJson(join(runDir, 'hashes.json'));
  const served = String(h?.served ?? '');
  const root = snapshotsRoot();
  if (!served || !existsSync(root)) return null;
  const ws = h?.workspace ? String(h.workspace) : null;
  const names = readdirSync(root).filter((n) => (n === served || n.endsWith(`-${served}`)) && (!ws || snapshotWorkspace(join(root, n)) === ws));
  const name = names.includes(served) ? served : names.length === 1 ? names[0]! : null;
  return name ? join(root, name) : null;
}

/** The org tree the page paints behind the proposal: what `cast org ls --json` answered when the snapshot was taken. */
function treeFor(runDir: string): string | null {
  const dir = runSnapshotDir(runDir);
  const path = dir ? join(dir, legacyFile(['org', 'ls'])!) : null;
  if (path && existsSync(path)) return readFileSync(path, 'utf8');
  console.error(`note: no snapshot with an org-ls.json matches ${join(runDir, 'hashes.json')}; the page paints without the saved tree`);
  return null;
}

/** The captures, over the raw bridge, in this session's Cast tab on localhost:3200/org. */
async function captureShots(runDir: string, out: string): Promise<void> {
  const spec = readFileSync(join(runDir, 'proposal.json'), 'utf8');
  JSON.parse(spec);
  const tree = treeFor(runDir);
  const loadJs = `sessionStorage.setItem("org-preview-spec", ${JSON.stringify(spec)});${tree ? `sessionStorage.setItem("org-preview-tree", ${JSON.stringify(tree)});` : ''}"stored"`;
  writeFileSync(join(out, 'load.js'), loadJs);

  const bridge = JSON.parse(readFileSync(BRIDGE_FILE, 'utf8')) as { port: number; token: string };
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/devtools/browser/${bridge.token}`);
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => pending.has(i) && (pending.delete(i), res({ error: `timeout ${method}` })), 60_000);
    });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) (pending.get(m.id)!(m.error ? { error: m.error } : m.result), pending.delete(m.id));
  };
  await new Promise((r) => (ws.onopen = r));
  let cleanup = async (): Promise<void> => {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
  try {
    const orgTab = async () => ((await send('Target.getTargets')).targetInfos ?? []).find((x: any) => x.type === 'page' && /localhost:3200\/org/.test(x.url));
    // This session's existing Cast tab only: capture never creates a tab or touches another.
    const t = await orgTab();
    if (!t) throw new Error(`no localhost:3200/org tab; open one with cast browser open ${PREVIEW}`);
    if (process.env.FOREGROUND) await send('Target.activateTarget', { targetId: t.targetId });
    const sessionId: string | undefined = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }))?.sessionId;
    if (!sessionId) throw new Error('could not attach to the org tab over the bridge');
    for (let i = 0; i < 5 && (await send('Runtime.enable', {}, sessionId))?.error; i++) await sleep(1500);
    await send('Page.enable', {}, sessionId);
    // The product's tours start themselves on the org page, and on ?preview=1 they are never recorded as
    // seen, so one lands on every navigation and the judge would grade its overlay. Hide the tour layer and
    // the Tours panel for the capture only; the script is removed again in the finally below.
    const hideTours = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '${TOUR_UI}{display:none!important}'; document.head.appendChild(s); });` }, sessionId))?.identifier;
    cleanup = async () => {
      if (hideTours) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hideTours }, sessionId);
    };
    const ev = async (expression: string) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      return r?.result?.value ?? `ERR ${JSON.stringify(r).slice(0, 200)}`;
    };
    const viewport = (width: number, height: number, mobile: boolean) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile }, sessionId);
    const nav = (url: string) => (log('nav', url), send('Page.navigate', { url }, sessionId));
    const waitText = async (re: RegExp, tries = 400) => {
      for (let i = 0; i < tries; i++) {
        const txt = await ev('document.body ? document.body.innerText : ""');
        if (typeof txt === 'string' && re.test(txt)) return;
        await sleep(1000);
      }
      log('gave up waiting for', re);
    };
    const shot = async (name: string) => {
      const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, sessionId);
      if (r?.data) writeFileSync(join(out, `${name}.png`), Buffer.from(r.data, 'base64'));
      log(r?.data ? 'shot' : 'shot failed', name);
    };
    const clickFirst = (filter: string) => ev(`(() => { const el=[...document.querySelectorAll('button,summary,[role=button]')].filter(e=>!e.closest('${TOUR_UI}')).filter(e=>${filter})[0]; if(!el) return 'none'; el.scrollIntoView({block:'start'}); el.click(); return 'clicked'; })()`);

    await viewport(1440, 900, false);
    await nav(PREVIEW);
    await waitText(/Codecast|Org|role|Chief/i);
    await sleep(1500);
    log('store:', await ev(loadJs));
    await nav(`${PREVIEW}&proposal=op-1`);
    await waitText(/decided/);
    await sleep(2000);
    await shot('desktop');
    log('fold:', await clickFirst(`/^\\s*\\d+ (records|changes)\\s*$/.test(e.textContent||'')`));
    await sleep(2000);
    await shot('fold');
    log('ask:', await clickFirst(`/Ask about this/.test(e.textContent||'')`));
    await sleep(1500);
    await shot('ask');
    await viewport(390, 844, true);
    await nav(`${PREVIEW}&proposal=op-1`);
    await waitText(/decide/);
    await sleep(2500);
    await shot('phone');
    await viewport(1440, 900, false);
    await nav(PREVIEW);
    await sleep(3000);
    await waitText(/Chief|lead|role/i);
    await sleep(2500);
    await shot('chart');
    log('fit:', await ev(`(() => { const b=[...document.querySelectorAll('button')].filter(e=>/fit|Fit/.test(e.getAttribute('aria-label')||e.getAttribute('title')||'')); if(b[0]){b[0].click();return 'clicked';} return 'none'; })()`));
    await sleep(2500);
    await shot('chart-fit');
    await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  } finally {
    await cleanup();
    ws.close();
  }
}

/** The judge: reads the captures and the spec, grades each rubric line 0 to 3. */
async function gradeShots(runDir: string, out: string): Promise<CheckResult[]> {
  const rubric = parseRubric(readFileSync(RUBRIC_DOC, 'utf8'));
  const shots = SHOTS.map((s) => join(out, `${s}.png`)).filter(existsSync);
  if (!shots.length) throw new Error(`no captures in ${out}: nothing to grade`);
  const prompt = [
    'You grade how an org proposal is presented to a person, from screenshots of the real proposal page. You change nothing and run nothing; you only read.',
    '',
    `Read each of these screenshots with the Read tool: ${shots.join(', ')}. The proposal they render is ${join(runDir, 'proposal.json')}.`,
    '',
    'Grade every line of this rubric from 0 to 3 against what the screenshots show. A line the screenshots cannot show gets the score the evidence supports and says so.',
    '',
    ...rubric.map((r) => `${r.n}. ${r.text}`),
    '',
    'End your reply with one JSON object and nothing after it: {"lines": [{"n": <line number>, "score": <0 to 3>, "reasoning": "<one or two sentences naming what you saw>"}]}, one entry per line.',
  ].join('\n');
  const a = await runAgent({ prompt, model: JUDGE_MODEL, tools: ['Read'], maxTurns: 10 }, join(out, 'judge'), { dry: false });
  if (a.isError) throw new Error(`the presentation judge failed (exit ${a.exitCode}); see ${a.runSubdir}`);
  const checks = parseVerdict(a.said, rubric);
  writeFileSync(join(out, 'presentation.json'), JSON.stringify({ judgeModel: JUDGE_MODEL, costUsd: a.costUsd, checks }, null, 2));
  return checks;
}

/** Folds the presentation checks into the run's score.json (an old round without one keeps them in captures/presentation.json). */
export function mergePresentation(runDir: string, checks: CheckResult[]): Score | null {
  const path = join(runDir, 'score.json');
  if (!existsSync(path)) return null;
  const prev = JSON.parse(readFileSync(path, 'utf8')) as Score & Record<string, unknown>;
  const merged = [...prev.checks.filter((c) => !c.id.startsWith('presentation:')), ...checks];
  const score = { ...prev, ...scoreOf(prev.gates, merged, prev.judgeModel ? { costUsd: prev.judgeCostUsd ?? 0, model: prev.judgeModel } : null) };
  writeFileSync(path, JSON.stringify(score, null, 2));
  return score;
}

export async function capturePresentation(runDir: string): Promise<void> {
  refuseArchive(runDir);
  if (!existsSync(join(runDir, 'proposal.json'))) throw new Error(`${runDir} has no proposal.json; grade or replay it first`);
  const refusal = await presentationRefusal();
  if (refusal) throw new Error(refusal);
  const out = join(runDir, 'captures');
  mkdirSync(out, { recursive: true });
  await captureShots(runDir, out);
  const checks = await gradeShots(runDir, out);
  const score = mergePresentation(runDir, checks);
  for (const c of checks) console.log(`${c.id}  ${Math.round(c.score * 3)}/3  ${c.reasoning ?? ''}`);
  console.log(score ? `score.json updated: ${score.score.toFixed(2)} (${score.pass ? 'pass' : 'fail'})` : `checks in ${join(out, 'presentation.json')}`);
}
