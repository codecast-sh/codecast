import { parseCursorChatData } from '../cursorChatParser.js';
import type { TranscriptEmissionObserver } from '../parser.js';
import { assembleOpencodeRows, type SessionRow } from '../opencodeTranscriptAssembly.js';
import { OPENCODE_SESSION_ID_RE } from '../resumeCommand.js';
import { INGEST_MAX_BYTES } from './ingestTypes.js';
import { antigravityCwdFromWorkspaceUris } from '../antigravityPaths.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
type Query = {get:(...args:any[])=>any;all:(...args:any[])=>any[]};
async function open(file: string, writable = false): Promise<{query:(sql:string)=>Query;exec:(sql:string)=>void;close:()=>void}> {
  if (typeof Bun !== 'undefined') {
    const {Database} = await import('bun:sqlite');
    const db = new Database(file,writable ? {} : {readonly:true});
    return {query:sql=>db.query(sql),exec:sql=>db.exec(sql),close:()=>db.close()};
  }
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(file,{readOnly:!writable});
  return {query:sql=>db.prepare(sql),exec:sql=>db.exec(sql),close:()=>db.close()};
}
export async function readCursorIngest(file: string, offset: number, onEmit?: TranscriptEmissionObserver) {
  const db = await open(file);
  try {
    db.exec('BEGIN');
    const from = "FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata' ORDER BY rowid DESC LIMIT 1";
    const size = db.query(`SELECT length(CAST(value AS BLOB)) AS bytes ${from}`).get();
    if (size?.bytes > INGEST_MAX_BYTES) throw new Error('Cursor row resource limit');
    const row = db.query(`SELECT rowid,value ${from}`).get();
    if (!row) return {messages:[],maxRowId:0,totalCount:0,rawBubbleCount:0};
    let rawBubbleCount = 0;
    const messages = parseCursorChatData(row.value,true,onEmit,count=>{rawBubbleCount=count;});
    if (!Number.isSafeInteger(rawBubbleCount) || rawBubbleCount < messages.length || rawBubbleCount > INGEST_MAX_BYTES) throw new Error('Cursor bubble resource limit');
    return {messages:messages.slice(offset),maxRowId:row.rowid,totalCount:messages.length,rawBubbleCount};
  } finally { db.close(); }
}
export async function readOpencodeIngest(file: string, sessionId: string) {
  const db = await open(file);
  try {
    db.exec('BEGIN');
    const session = db.query('SELECT id,directory,title,version,project_id,slug,time_created,time_updated FROM session WHERE id = ?').get(sessionId) as SessionRow | undefined;
    if (!session) return {content:'',sessionExists:false};
    let bytes = 0;
    for (const table of ['message','part']) {
      const size = db.query(`SELECT count(*) AS rows,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM ${table} WHERE session_id = ?`).get(sessionId);
      bytes += size.bytes;
      if (size.rows > 100_000 || bytes > INGEST_MAX_BYTES) throw new Error('Opencode rows resource limit');
    }
    const messages = db.query('SELECT id,data FROM message WHERE session_id = ? ORDER BY time_created,id').all(sessionId);
    const parts = db.query('SELECT message_id,id,data FROM part WHERE session_id = ? ORDER BY message_id,id').all(sessionId);
    const columns = new Set(db.query('PRAGMA table_info(session)').all().map(row=>row.name));
    const lineage = columns.has('parent_id') && columns.has('agent') ? db.query('SELECT parent_id,agent FROM session WHERE id = ?').get(sessionId) : undefined;
    return {sessionExists:true,content:assembleOpencodeRows(session,messages,parts,true) ?? '',cwd:session.directory ?? undefined,parentSessionId:lineage?.parent_id && OPENCODE_SESSION_ID_RE.test(lineage.parent_id) ? lineage.parent_id : undefined,agentName:lineage?.agent ?? undefined};
  } finally { db.close(); }
}
/**
 * One conversation's row in Antigravity's conversation_summaries.db: the
 * workspace it runs in and whether a parent conversation started it.
 *
 * agy keeps the database in WAL mode, and while an agy runs there is no -shm
 * file beside it, so SQLite refuses every read-only open ("unable to open
 * database file", measured beside a running agy, 2026-11-22). Then the
 * database (and its -wal, when one exists) is copied to a temporary directory
 * and the copy opened writable, so SQLite can build its own index and replay
 * the log. The original is never opened for writing.
 */
export async function readAntigravitySummary(file: string, conversationId: string): Promise<{cwd?: string; parentConversationId?: string; nestingDepth?: number; title?: string} | undefined> {
  try { return await readAntigravitySummaryFrom(file, conversationId, false); }
  catch (error) { if (!/unable to open database file|SQLITE_CANTOPEN/i.test(String(error))) throw error; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agy-summaries-'));
  try {
    const copy = path.join(dir, 'conversation_summaries.db');
    await fs.promises.copyFile(file, copy);
    await fs.promises.copyFile(`${file}-wal`, `${copy}-wal`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    return await readAntigravitySummaryFrom(copy, conversationId, true);
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}
async function readAntigravitySummaryFrom(file: string, conversationId: string, writable: boolean): Promise<{cwd?: string; parentConversationId?: string; nestingDepth?: number; title?: string} | undefined> {
  const db = await open(file, writable);
  try {
    const columns = new Set(db.query('PRAGMA table_info(conversation_summaries)').all().map(row=>row.name));
    if (!columns.has('conversation_id') || !columns.has('workspace_uris')) return undefined;
    const pick = ['workspace_uris', ...['parent_conversation_id','nesting_depth','title'].filter(c => columns.has(c))].join(',');
    const row = db.query(`SELECT ${pick} FROM conversation_summaries WHERE conversation_id = ?`).get(conversationId);
    if (!row) return undefined;
    const parent = typeof row.parent_conversation_id === 'string' && row.parent_conversation_id ? row.parent_conversation_id : undefined;
    return {
      cwd: antigravityCwdFromWorkspaceUris(row.workspace_uris),
      parentConversationId: parent,
      nestingDepth: typeof row.nesting_depth === 'number' ? row.nesting_depth : undefined,
      title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : undefined,
    };
  } finally { db.close(); }
}
