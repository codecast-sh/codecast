export const SCAN_PAGE_ROWS = 128;
export const SCAN_PAGE_BYTES = 256 * 1024;
export const SCAN_DIR_POLICIES = ['all', 'claudeIndex', 'claudeWatch', 'gemini', 'codexWatch', 'grokWatch', 'cursor', 'vault'] as const;
export const SCAN_FILE_POLICIES = ['all', 'jsonl', 'claudeIndex', 'geminiIndex', 'piIndex', 'grokIndex', 'claudeWatch', 'geminiWatch', 'grokWatch', 'cursor', 'cursorStale', 'cursorDb', 'reconciliation', 'plan', 'vault'] as const;
export type ScanPolicy = { dirs?: typeof SCAN_DIR_POLICIES[number]; files?: typeof SCAN_FILE_POLICIES[number] };
export type ScanJob =
  | { name: 'walk'; root: string; policy: ScanPolicy; maxDepth?: number; stats: boolean; excludeCodexAppServer?: boolean; observeCwd?: boolean; requireComplete?: boolean }
  | { name: 'inventory'; home: string; projectPath?: string }
  | { name: 'roots'; home: string; started: string[] }
  | { name: 'recent'; home: string; sessionId: string; since: number; codexOnly: boolean; complete?: boolean }
  | { name: 'cursorDatabases'; paths: string[] }
  | { name: 'cursorWorkspaces'; root: string }
  | { name: 'cursorWorkspace'; home: string; root: string; sessionId: string }
  | { name: 'manifests'; home: string };
export type ScanFile = { type: 'file'; path: string; rel: string; depth: number; name: string; mtimeMs?: number; size?: number; cwd?: string | null };
export type ScanRow = { type: 'cursorWorkspaceDb'; path: string; mtimeMs: number; identity: string } | { type: 'cursorError'; path: string; message: string; code: string } | { type: 'cursorWorkspace'; workspacePath: string | null } | { type: 'cursorDb'; path: string; maxRowId: number | null; workspacePath: string | null } | ScanFile | { type: 'item' | 'marketplace' | 'unreadable' | 'manifest'; value: unknown } | { type: 'root'; path: string } | { type: 'recent'; path: string; agentType: string };
export type ScanPayload = { action: 'open'; job: ScanJob } | { action: 'next' | 'close'; cursor: string };
export type ScanPage = { cursor: string; rows: ScanRow[]; done: boolean };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
const keys = (v: Record<string, any>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export const validCursor = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(v);
export function validScanJob(v: unknown): v is ScanJob {
  if (!object(v)) return false;
  if (v.name === 'walk') return keys(v, ['name','root','policy','maxDepth','stats','excludeCodexAppServer','observeCwd','requireComplete']) && text(v.root) && object(v.policy) && keys(v.policy,['dirs','files']) && (v.policy.dirs === undefined || SCAN_DIR_POLICIES.includes(v.policy.dirs)) && (v.policy.files === undefined || SCAN_FILE_POLICIES.includes(v.policy.files)) && (v.maxDepth === undefined || Number.isInteger(v.maxDepth) && v.maxDepth >= 0 && v.maxDepth <= 1024) && typeof v.stats === 'boolean' && (v.excludeCodexAppServer === undefined || typeof v.excludeCodexAppServer === 'boolean') && (v.observeCwd === undefined || typeof v.observeCwd === 'boolean') && (v.requireComplete === undefined || typeof v.requireComplete === 'boolean');
  if (v.name === 'cursorWorkspaces') return keys(v,['name','root']) && text(v.root);
  if (v.name === 'cursorDatabases') return keys(v,['name','paths']) && Array.isArray(v.paths) && v.paths.length <= SCAN_PAGE_ROWS && v.paths.every(text);
  if (!text(v.home)) return false;
  if (v.name === 'cursorWorkspace') return keys(v,['name','home','root','sessionId']) && text(v.root) && typeof v.sessionId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v.sessionId);
  if (v.name === 'inventory') return keys(v, ['name','home','projectPath']) && (v.projectPath === undefined || text(v.projectPath));
  if (v.name === 'roots') return keys(v, ['name','home','started']) && Array.isArray(v.started) && v.started.length <= 300 && v.started.every(text);
  if (v.name === 'recent') return keys(v, ['name','home','sessionId','since','codexOnly','complete']) && typeof v.sessionId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v.sessionId) && Number.isFinite(v.since) && typeof v.codexOnly === 'boolean' && (v.complete === undefined || typeof v.complete === 'boolean');
  return v.name === 'manifests' && keys(v, ['name','home']);
}
export function validScanPayload(v: unknown): v is ScanPayload {
  return object(v) && (v.action === 'open' ? keys(v,['action','job']) && validScanJob(v.job) : ['next','close'].includes(v.action) && keys(v,['action','cursor']) && validCursor(v.cursor));
}
export function validScanPage(v: unknown): v is ScanPage {
  if (!object(v) || !keys(v,['cursor','rows','done']) || !validCursor(v.cursor) || typeof v.done !== 'boolean' || !Array.isArray(v.rows) || v.rows.length > SCAN_PAGE_ROWS) return false;
  if (Buffer.byteLength(JSON.stringify(v)) > SCAN_PAGE_BYTES) return false;
  return v.rows.every((r: unknown) => {
    if (!object(r)) return false;
    if (r.type === 'file') return keys(r,['type','path','rel','depth','name','mtimeMs','size','cwd']) && text(r.path) && text(r.rel) && text(r.name) && Number.isInteger(r.depth) && r.depth >= 1 && (r.mtimeMs === undefined || Number.isFinite(r.mtimeMs)) && (r.size === undefined || Number.isSafeInteger(r.size) && r.size >= 0) && (r.cwd === undefined || r.cwd === null || text(r.cwd));
    if (r.type === 'cursorWorkspace') return keys(r,['type','workspacePath']) && (r.workspacePath === null || text(r.workspacePath));
    if (r.type === 'cursorWorkspaceDb') return keys(r,['type','path','mtimeMs','identity']) && text(r.path) && Number.isFinite(r.mtimeMs) && text(r.identity);
    if (r.type === 'cursorError') return keys(r,['type','path','message','code']) && text(r.path) && text(r.message) && text(r.code);
    if (r.type === 'cursorDb') return keys(r,['type','path','maxRowId','workspacePath']) && text(r.path) && (r.maxRowId === null || Number.isSafeInteger(r.maxRowId) && r.maxRowId >= 0) && (r.workspacePath === null || text(r.workspacePath));
    if (r.type === 'root') return keys(r,['type','path']) && text(r.path);
    if (r.type === 'recent') return keys(r,['type','path','agentType']) && text(r.path) && ['claude','codex','gemini','pi','grok'].includes(r.agentType);
    return ['item','marketplace','unreadable','manifest'].includes(r.type) && keys(r,['type','value']) && object(r.value);
  });
}
