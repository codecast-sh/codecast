import { parseCursorChatData } from '../cursorChatParser.js';
import type { TranscriptEmissionObserver } from '../parser.js';
import { assembleOpencodeRows, type SessionRow } from '../opencodeTranscriptAssembly.js';
import { OPENCODE_SESSION_ID_RE } from '../resumeCommand.js';
import { INGEST_MAX_BYTES } from './ingestTypes.js';
type Query = {get:(...args:any[])=>any;all:(...args:any[])=>any[]};
async function open(file: string): Promise<{query:(sql:string)=>Query;exec:(sql:string)=>void;close:()=>void}> {
  if (typeof Bun !== 'undefined') {
    const {Database} = await import('bun:sqlite');
    const db = new Database(file,{readonly:true});
    return {query:sql=>db.query(sql),exec:sql=>db.exec(sql),close:()=>db.close()};
  }
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(file,{readOnly:true});
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
    if (!row) return {messages:[],maxRowId:0,totalCount:0};
    const messages = parseCursorChatData(row.value,true,onEmit);
    return {messages:messages.slice(offset),maxRowId:row.rowid,totalCount:messages.length};
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
