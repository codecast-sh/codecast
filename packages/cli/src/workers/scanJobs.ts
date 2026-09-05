import fs from 'node:fs';
import path from 'node:path';
import { readTranscriptCwdAsync } from './transcriptObservation.js';
import { scanPredicates } from './scanPolicy.js';
import { SCAN_PAGE_BYTES, SCAN_PAGE_ROWS, type ScanJob, type ScanRow } from './scanTypes.js';
import { isAppServerManagedCodexSessionHead } from '../codexWatcher.js';
export const scanPathMissing = (error: unknown) => ['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
export const scanYield = () => new Promise<void>(resolve => setImmediate(resolve));
async function head(file: string): Promise<string> {
  const handle = await fs.promises.open(file, 'r');
  try { const b = Buffer.alloc(2048); const r = await handle.read(b,0,b.length,0); return b.subarray(0,r.bytesRead).toString('utf8'); }
  finally { await handle.close(); }
}
export async function* walkScanRows(job: Extract<ScanJob,{name:'walk'}>): AsyncGenerator<ScanRow> {
  const { dirFilter, fileFilter } = scanPredicates(job.root, job.policy);
  const stack = [{ dir: job.root, depth: 0 }];
  const maxDepth = job.maxDepth ?? Infinity;
  let visited = 0;
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[], before: fs.Stats | undefined;
    try {
      if (job.requireComplete) {
        before = await fs.promises.lstat(dir);
        if (!before.isDirectory()) throw new Error('incomplete scan directory');
      }
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (job.requireComplete && !(dir === job.root && (error as NodeJS.ErrnoException)?.code === 'ENOENT')) throw error;
      continue;
    }
    const subdirs: typeof stack = [];
    for (const entry of entries) {
      if (++visited % SCAN_PAGE_ROWS === 0) await scanYield();
      if (job.requireComplete && entry.isSymbolicLink()) throw new Error('incomplete scan symlink');
      const full = path.join(dir,entry.name), rel = path.relative(job.root,full);
      if (entry.isDirectory()) {
        if (depth + 1 < maxDepth && dirFilter(rel)) subdirs.push({ dir: full, depth: depth+1 });
      } else if (entry.isFile() && depth + 1 <= maxDepth && fileFilter(rel)) {
        let stat: fs.Stats | undefined;
        try {
          if (job.stats) stat = await fs.promises.stat(full);
          if (job.excludeCodexAppServer && isAppServerManagedCodexSessionHead(await head(full))) continue;
        } catch (error) { if (job.requireComplete && !scanPathMissing(error)) throw error; continue; }
        yield { type:'file', path:full, rel, depth:depth+1, name:entry.name, ...(stat ? { mtimeMs:stat.mtimeMs, size:stat.size } : {}), ...(job.observeCwd ? { cwd: await readTranscriptCwdAsync(full) } : {}) };
      }
    }
    if (before) {
      const after = await fs.promises.lstat(dir);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('scan directory changed');
    }
    for (let i = subdirs.length-1; i >= 0; i--) stack.push(subdirs[i]);
  }
}
async function freshDirs(parent: string, since: number): Promise<string[]> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(parent,{withFileTypes:true}); } catch (error) { if (!scanPathMissing(error)) throw error; return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(parent,e.name);
    try { if ((await fs.promises.stat(full)).mtimeMs >= since) out.push(full); } catch (error) { if (!scanPathMissing(error)) throw error; }
  }
  return out;
}
export async function recentScan(job: Extract<ScanJob,{name:'recent'}>): Promise<ScanRow[]> {
  const exists = async (p: string) => { try { await fs.promises.access(p); return true; } catch (error) { if (!scanPathMissing(error)) throw error; return false; } };
  const found = (p: string, agentType: string): ScanRow[] => [{type:'recent',path:p,agentType}];
  if (!job.codexOnly) for (const dir of await freshDirs(path.join(job.home,'.claude','projects'),job.since)) {
    const p = path.join(dir,`${job.sessionId}.jsonl`); if (await exists(p)) return found(p,'claude');
  }
  const stack = [{dir:path.join(job.home,'.codex','sessions'),depth:0}];
  while (stack.length) {
    const {dir,depth} = stack.pop()!;
    let entries: fs.Dirent[], mtime: number;
    try { mtime = (await fs.promises.stat(dir)).mtimeMs; entries = await fs.promises.readdir(dir,{withFileTypes:true}); } catch (error) { if (!scanPathMissing(error)) throw error; continue; }
    if (job.complete || mtime >= job.since) for (const e of entries) if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(job.sessionId)) return found(path.join(dir,e.name),'codex');
    if (job.complete || depth < 3) for (let i=entries.length-1;i>=0;i--) if(entries[i].isDirectory()) stack.push({dir:path.join(dir,entries[i].name),depth:depth+1});
    await scanYield();
  }
  if (job.codexOnly) return [];
  for (const dir of await freshDirs(path.join(job.home,'.gemini','tmp'),job.since)) {
    const p=path.join(dir,'chats',`${job.sessionId}.json`); if(await exists(p)) return found(p,'gemini');
  }
  for (const dir of await freshDirs(path.join(job.home,'.pi','agent','sessions'),job.since)) {
    let entries: fs.Dirent[]; try { entries=await fs.promises.readdir(dir,{withFileTypes:true}); } catch (error) { if (!scanPathMissing(error)) throw error; continue; }
    for (const e of entries) if(e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(job.sessionId)) return found(path.join(dir,e.name),'pi');
  }
  for (const dir of await freshDirs(path.join(job.home,'.grok','sessions'),job.since)) {
    const p=path.join(dir,job.sessionId,'updates.jsonl'); if(await exists(p)) return found(p,'grok');
  }
  return [];
}
export async function* scanJobRows(job: ScanJob): AsyncGenerator<ScanRow> {
  if (job.name === 'walk') { yield* walkScanRows(job); return; }
  if (job.name === 'cursorDatabases') {
    const { observeCursorDatabase, cursorScanError } = await import('./cursorObservation.js');
    for (const file of job.paths) {
      try { yield await observeCursorDatabase(file); } catch (error) { yield cursorScanError(file,error); }
    }
    return;
  }
  if (job.name === 'cursorWorkspaces') {
    const {observeCursorWorkspaces}=await import('./cursorObservation.js');
    yield* observeCursorWorkspaces(job.root);
    return;
  }
  if (job.name === 'cursorWorkspace') {
    const { findCursorWorkspace } = await import('./cursorObservation.js');
    const workspacePath = await findCursorWorkspace(job);
    yield {type:'cursorWorkspace',workspacePath};
    return;
  }
  if (job.name === 'recent') { yield* await recentScan(job); return; }
  if (job.name === 'inventory') {
    const { readInventoryAsyncLocal } = await import('../capabilities/inventory.js');
    const inv = await readInventoryAsyncLocal(job.home,job.projectPath);
    for (const value of inv.items) yield {type:'item',value};
    for (const value of inv.marketplaces) yield {type:'marketplace',value};
    for (const value of inv.unreadable) yield {type:'unreadable',value};
    return;
  }
  if (job.name === 'roots') {
    const { enumerateLocalRootsAsync } = await import('../projectRoots.js');
    for (const p of await enumerateLocalRootsAsync(job.home,job.started)) yield {type:'root',path:p};
    return;
  }
  const { readInstalledPluginObservations } = await import('../capabilities/manifests.js');
  for (const value of readInstalledPluginObservations(job.home)) yield {type:'manifest',value};
}
export async function* scanPages(job: ScanJob): AsyncGenerator<ScanRow[]> {
  let rows: ScanRow[] = [], bytes = 256;
  for await (const row of scanJobRows(job)) {
    const size = Buffer.byteLength(JSON.stringify(row))+1;
    if (size + 256 > SCAN_PAGE_BYTES) throw new Error('scan row too large');
    if (rows.length && (rows.length >= SCAN_PAGE_ROWS || bytes + size > SCAN_PAGE_BYTES)) { yield rows; rows=[]; bytes=256; }
    rows.push(row); bytes+=size;
  }
  if (rows.length) yield rows;
}
