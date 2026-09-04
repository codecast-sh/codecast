import fs from 'node:fs';
import path from 'node:path';
import type { ScanRow } from './scanTypes.js';

export async function observeCursorDatabase(file: string): Promise<Extract<ScanRow,{type:'cursorDb'}>> {
  let maxRowId: number | null = null;
  let workspacePath: string | null = null;
  let close: (() => void) | undefined;
  try {
    await fs.promises.access(file, fs.constants.R_OK);
    const query = typeof Bun !== 'undefined'
      ? (() => import('bun:sqlite').then(({Database}) => {
        const db = new Database(file,{readonly:true});
        close = () => db.close();
        return (sql: string) => db.query(sql).get();
      }))()
      : import('node:sqlite').then(({DatabaseSync}) => {
        const db = new DatabaseSync(file,{readOnly:true});
        close = () => db.close();
        return (sql: string) => db.prepare(sql).get();
      });
    const get = await query;
    if (get("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'")) {
      const row = get("SELECT MAX(rowid) as maxRowId FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'") as {maxRowId: number | null} | undefined;
      maxRowId = row?.maxRowId ?? 0;
    }
  } finally { close?.(); }
  try {
    const data = JSON.parse(await fs.promises.readFile(path.join(path.dirname(file),'workspace.json'),'utf8'));
    const uri = data.folder || data.workspace;
    if (typeof uri === 'string') workspacePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri;
    if (process.platform === 'win32' && workspacePath?.match(/^\/[A-Z]:/i)) workspacePath = workspacePath.slice(1);
  } catch {}
  return {type:'cursorDb',path:file,maxRowId,workspacePath};
}

type ComposerObservation = { identity: string; ids: Set<string>; workspacePath: string | null };
const composerCache = new Map<string, ComposerObservation>();
const fileIdentity = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}`;
async function composerIdentity(file: string): Promise<string> {
  const parts: string[] = [];
  for (const candidate of [file, `${file}-wal`, path.join(path.dirname(file), 'workspace.json')]) {
    try { await fs.promises.access(candidate, fs.constants.R_OK); parts.push(fileIdentity(await fs.promises.stat(candidate))); }
    catch (error) {
      if (candidate === file || (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      parts.push('absent');
    }
  }
  return parts.join('|');
}

async function observeComposers(file: string, home: string): Promise<ComposerObservation> {
  const key = `${home}:${file}`, identity = await composerIdentity(file);
  const memo = composerCache.get(key);
  if (memo?.identity === identity) return memo;
  composerCache.delete(key);
  let close: (() => void) | undefined;
  try {
    const get = typeof Bun !== 'undefined'
      ? await import('bun:sqlite').then(({Database}) => {
        const db = new Database(file, {readonly:true});
        close = () => db.close();
        return (sql: string) => db.query(sql).get();
      })
      : await import('node:sqlite').then(({DatabaseSync}) => {
        const db = new DatabaseSync(file, {readOnly:true});
        close = () => db.close();
        return (sql: string) => db.prepare(sql).get();
      });
    const row = get("SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1") as {value: string} | undefined;
    const data = row?.value ? JSON.parse(row.value) : {};
    if (data.allComposers !== undefined && !Array.isArray(data.allComposers)) throw new Error('invalid Cursor composers');
    const ids = new Set<string>();
    for (const composer of data.allComposers ?? []) if (typeof composer?.composerId === 'string') ids.add(composer.composerId);
    let workspacePath: string | null = null;
    try {
      const workspace = JSON.parse(await fs.promises.readFile(path.join(path.dirname(file), 'workspace.json'), 'utf8'));
      const uri = workspace.folder || workspace.workspace;
      if (typeof uri === 'string') workspacePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri;
      if (process.platform === 'win32' && workspacePath?.match(/^\/[A-Z]:/i)) workspacePath = workspacePath.slice(1);
    } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
    if (identity !== await composerIdentity(file)) throw new Error('Cursor database changed during observation');
    const result = {identity, ids, workspacePath};
    if (composerCache.size >= 256) composerCache.delete(composerCache.keys().next().value!);
    composerCache.set(key, result);
    return result;
  } finally { close?.(); }
}

export async function findCursorWorkspace(job: { home: string; root: string; sessionId: string }): Promise<string | null> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(job.root, {withFileTypes:true}); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(job.root, entry.name, 'state.vscdb');
    let observation: ComposerObservation;
    try { observation = await observeComposers(file, job.home); }
    catch (error) {
      composerCache.delete(`${job.home}:${file}`);
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
    if (observation.ids.has(job.sessionId)) return observation.workspacePath;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return null;
}

export function cursorScanError(file: string, error: unknown): Extract<ScanRow,{type:'cursorError'}> {
  return {type:'cursorError',path:file,message:(error instanceof Error ? error.message : String(error)).slice(0,4096) || 'Cursor read failed',code:String((error as NodeJS.ErrnoException)?.code || 'read_failed').slice(0,256)};
}

export async function* observeCursorWorkspaces(root: string): AsyncGenerator<ScanRow> {
  const {walkScanRows} = await import('./scanJobs.js');
  try { await fs.promises.readdir(root); }
  catch (error) { yield cursorScanError(root,error); return; }
  for await (const row of walkScanRows({name:'walk',root,policy:{files:'cursorDb'},maxDepth:2,stats:false})) {
    if(row.type !== 'file' || row.depth !== 2 || path.basename(row.path) !== 'state.vscdb') continue;
    try {
      const identity=await composerIdentity(row.path);
      const db=await fs.promises.stat(row.path),wal=await fs.promises.stat(`${row.path}-wal`).catch(()=>null);
      yield {type:'cursorWorkspaceDb',path:row.path,mtimeMs:Math.max(db.mtimeMs,wal?.mtimeMs ?? 0),identity};
    } catch(error) { yield cursorScanError(row.path,error); }
  }
}
