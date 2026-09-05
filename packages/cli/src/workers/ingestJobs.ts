import { ingestReceiptSignature } from "./ingestReceipt.js";
import type { ParsedMessage, TranscriptEmission } from "../parser.js";
import { detectPermissionPrompt } from "../permissionDetector.js";
import { generateTitleFromMessage } from "./ingestMetadata.js";
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readCompleteLines, cursorPassBoundary, readCodexSessionMetaHeadAsync } from '../transcriptWindow.js';
import { readCodexModelBeforeOffset } from '../codexTranscriptModel.js';
import { isCursorRoleHeaderLine, parseTranscriptFor, parseCodexSessionFile, parseSessionFile, extractSlug, extractParentUuid, extractCwd, extractCodexCwd, extractSummaryTitle, extractTeamInfo, detectCliFlags, extractCodexSessionMetadata, extractCodexForkRoot, isCompletedStandaloneCodexReview, isCompletedNativeCodexReviewChild, extractPiCwd, extractGrokCwd, isGrokInternalSession } from '../parser.js';
import { recoverImagesFromBackup, classifyOpencodeTranscriptTail, classifyPiTranscriptTail, classifyGrokTranscriptTail } from './ingestMetadata.js';
import { INGEST_WINDOW_ROWS, INGEST_MAX_BYTES, type IngestJob, type IngestIdentity, type IngestResult } from './ingestTypes.js';
import { validateIngestResult } from './ingestValidation.js';
export function ingestIdentity(s: fs.Stats): IngestIdentity {
  return {dev:s.dev,ino:s.ino,birthtimeMs:s.birthtimeMs,ctimeMs:s.ctimeMs,mtimeMs:s.mtimeMs,size:s.size};
}
export function sameIngestFile(a: IngestIdentity, b: IngestIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}
export function sameIngestSnapshot(a: IngestIdentity, b: IngestIdentity): boolean {
  return sameIngestFile(a,b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
export async function ingestWalIdentity(file: string): Promise<IngestIdentity | null> {
  try { return ingestIdentity(await fs.promises.stat(file+'-wal')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; }
}
export function sameIngestWal(a: IngestIdentity | null, b: IngestIdentity | null): boolean {
  return a === null || b === null ? a === b : sameIngestSnapshot(a,b);
}
async function readPart(file: string, length: number, tail = false): Promise<string> {
  const fd = await fs.promises.open(file,'r');
  try {
    const size = (await fd.stat()).size;
    const buf = Buffer.alloc(Math.min(size,length));
    const {bytesRead} = await fd.read(buf,0,buf.length,tail ? Math.max(0,size-length) : 0);
    return buf.toString('utf8',0,bytesRead);
  } finally { await fd.close(); }
}
async function whole(file: string): Promise<string> {
  const fd = await fs.promises.open(file,'r');
  try {
    const size = (await fd.stat()).size;
    if (size > INGEST_MAX_BYTES) throw new Error('ingest source resource limit');
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const {bytesRead} = await fd.read(buffer,offset,Math.min(1024*1024,size-offset),offset);
      if (!bytesRead) throw new Error('ingest source shortened');
      offset += bytesRead;
    }
    return buffer.toString('utf8');
  } finally { await fd.close(); }
}
async function windowFor(job: IngestJob, before: IngestIdentity) {
  const fd = await fs.promises.open(job.file,'r');
  try {
    if (!sameIngestSnapshot(before,ingestIdentity(await fd.stat()))) throw new Error('ingest handle changed');
    const available = Math.max(0,before.size-job.offset), limited = Math.min(available,INGEST_MAX_BYTES);
    const result = await readCompleteLines(fd,job.offset,limited,{boundary:(buf,len,eof,from) => {
      const cut = job.client === 'cursor' ? cursorPassBoundary(buf,len,eof && limited === available,from) : buf.lastIndexOf(0x0a,len-1);
      if (cut < 0) return cut;
      let records = 0;
      for (let start=0;start<=cut;) {
        const end=buf.indexOf(0x0a,start);
        if (end<0 || end>cut) break;
        if (job.client === 'cursor') {
          if (isCursorRoleHeaderLine(buf.toString('utf8',start,end)) && ++records > INGEST_WINDOW_ROWS) return start-1;
        } else if (++records >= INGEST_WINDOW_ROWS) return end;
        start=end+1;
      }
      return cut;
    }});
    if (!result.bytesConsumed && limited < available) throw new Error('ingest line resource limit');
    const after = ingestIdentity(await fd.stat());
    if (!sameIngestFile(before,after) || after.size < before.size || after.size === before.size && !sameIngestSnapshot(before,after)) throw new Error('ingest handle changed during read');
    return result;
  } finally { await fd.close(); }
}
async function optional<T>(read: () => Promise<T>, warnings: string[], label: string): Promise<T | undefined> {
  try { return await read(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['ENOENT','EACCES','EPERM','EIO'].includes(code ?? '')) throw error;
    warnings.push(`${label}: ${code}`);
    return undefined;
  }
}
function strictLines(content: string) {
  for (const line of content.split('\n')) if (line.trim()) JSON.parse(line);
}
export async function readIngestJob(job: IngestJob, checkpoint: () => void = () => {}): Promise<IngestResult> {
  checkpoint();
  const before = ingestIdentity(await fs.promises.stat(job.file));
  if (job.walIdentity !== undefined && !sameIngestWal(job.walIdentity,await ingestWalIdentity(job.file))) throw new Error('ingest WAL changed before read');
  if (!sameIngestSnapshot(before,job.identity)) throw new Error('ingest source changed before read');
  const result: IngestResult = {messages:[],bytesConsumed:0,fileSize:before.size,totalCount:0,maxRowId:0,metadata:{warnings:[]}};
  const meta = result.metadata;
  const emissions = new WeakMap<ParsedMessage, TranscriptEmission>();
  let content = '';
  if (job.client === 'cursorDb') {
    const {readCursorIngest} = await import('./ingestDatabase.js');
    Object.assign(result,await readCursorIngest(job.file,job.offset));
  } else if (job.client === 'opencode') {
    const {readOpencodeIngest} = await import('./ingestDatabase.js');
    const snapshot = await readOpencodeIngest(job.file,job.sessionId);
    content = snapshot.content;
    meta.sessionExists = snapshot.sessionExists;
    if (content) {
      result.messages = parseTranscriptFor('opencode',content);
      meta.cwd = snapshot.cwd; meta.parentSessionId = snapshot.parentSessionId; meta.agentName = snapshot.agentName;
      meta.title = JSON.parse(content).info?.title;
      meta.turn = classifyOpencodeTranscriptTail(content);
    }
  } else {
    if (['claude','cursor','codex'].includes(job.client)) {
      const window = await windowFor(job,before);
      content = window.content; result.bytesConsumed = window.bytesConsumed;
    } else {
      content = await whole(job.file);
      if (job.client !== 'gemini') content = content.slice(0,content.lastIndexOf('\n')+1);
    }
    if (content) {
      if (job.client === 'gemini') JSON.parse(content);
      else if (job.client !== 'cursor') strictLines(content);
      if (job.client === 'codex') {
        const state = {model:job.modelKnown ? job.model : await readCodexModelBeforeOffset(job.file,job.offset,INGEST_MAX_BYTES)};
        result.messages = parseCodexSessionFile(content,state); result.model = state.model;
      } else result.messages = parseTranscriptFor(job.client,content,["claude","gemini"].includes(job.client) ? (message, source) => emissions.set(message,source) : undefined);
    }
    if (job.client === 'claude') {
      if (job.recoverBackup && fs.existsSync(job.file+'.bak')) {
        result.messages = recoverImagesFromBackup(result.messages,job.file+'.bak',message => meta.warnings.push(message));
        meta.backupAttempted = true;
      }
      const rawHead = await optional(() => readPart(job.file,16384),meta.warnings,'head');
      const head = rawHead?.slice(0,rawHead.lastIndexOf('\n')+1);
      if (head !== undefined) {
        meta.slug = extractSlug(head); meta.parentUuid = extractParentUuid(head); meta.cwd = extractCwd(head);
        meta.headMessages = parseSessionFile(head).filter(m => m.role === 'user').slice(0,3);
      }
      meta.cliFlags = detectCliFlags((head ?? '')+'\n'+content);
      meta.teamInfo = extractTeamInfo(content);
      meta.planTools = [];
      for (const [lineIndex,line] of content.split('\n').entries()) {
        if (!line.includes('ExitPlanMode') && !line.includes('TaskCreate') && !line.includes('TaskUpdate')) continue;
        const entry = JSON.parse(line), message = entry.message ?? entry;
        if (Array.isArray(message.content)) for (const [blockIndex,block] of message.content.entries()) {
          if (block.type === 'tool_use' && ['ExitPlanMode','TaskCreate','TaskUpdate'].includes(block.name)) {
            const nativeIds = [job.sessionId,entry.uuid,block.id];
            const native = nativeIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\s\x00-\x1f]/.test(id));
            const occurrence = createHash('sha256').update(JSON.stringify(native
              ? ['native',job.client,...nativeIds]
              : ['physical-fallback',job.client,job.sessionId,job.file,job.identity.dev,job.identity.ino,job.identity.birthtimeMs,entry.uuid ?? [job.offset,lineIndex],blockIndex,block.id ?? null])).digest('hex');
            meta.planTools.push({name:block.name,input:block.input,occurrence});
          }
        }
      }
      if (job.file.split(path.sep).includes('subagents')) {
        const raw = await optional(() => whole(job.file.replace(/\.jsonl$/,'.meta.json')),meta.warnings,'subagent metadata');
        if (raw !== undefined) { const info = JSON.parse(raw); meta.subagent = {description:info.description,agentType:info.agentType}; }
      }
    }
    if (job.client === 'codex') {
      meta.appServerHead = await readPart(job.file,4096);
      meta.cwd = extractCodexCwd(await readPart(job.file,16384));
      const head = await readCodexSessionMetaHeadAsync(job.file);
      meta.codex = extractCodexSessionMetadata(head); meta.forkRoot = extractCodexForkRoot(head);
      if (meta.codex?.originator === 'codex_exec' && content.includes('"task_complete"')) {
        const full = await optional(() => whole(job.file),meta.warnings,'review metadata') ?? content;
        meta.completedReview = isCompletedStandaloneCodexReview(meta.codex,full) || isCompletedNativeCodexReviewChild(meta.codex,full);
      }
    }
    if (job.client === 'claude' || job.client === 'codex') {
      const tail = await optional(() => readPart(job.file,4096,true),meta.warnings,'title');
      meta.summaryTitle = extractSummaryTitle(content+'\n'+(tail ?? ''));
    }
    if (job.client === 'pi') { meta.cwd = extractPiCwd(content); meta.turn = classifyPiTranscriptTail(content); }
    if (job.client === 'grok') {
      const summary = await optional(() => whole(path.join(path.dirname(job.file),'summary.json')),meta.warnings,'grok summary');
      if (summary !== undefined) { meta.cwd = extractGrokCwd(summary); meta.internal = isGrokInternalSession(summary); }
      meta.turn = classifyGrokTranscriptTail(content);
    }
  }
  if (job.client !== 'cursorDb') result.totalCount = result.messages.length;
  if (job.client === 'claude') {
    const lastAssistant = result.messages.filter(m => m.role === 'assistant').at(-1);
    meta.permissionPrompt = lastAssistant ? detectPermissionPrompt(lastAssistant.content) : null;
  }
  result.handoffParents = result.messages.map(m => {
    if (m.role !== 'user') return null;
    const handoff = m.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
    return handoff ? handoff[1].match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1] ?? '' : null;
  });
  result.messageTitles = result.messages.map(m => m.role === "user" ? generateTitleFromMessage(m.content) : null);
  result.signatures = result.messages.map(m => createHash('sha256').update(JSON.stringify(m)).digest('hex'));
  if (job.client === 'cursor') result.receiptSignatures = result.messages.map(m => createHash('sha256').update(JSON.stringify({...m,timestamp:0})).digest('hex')); 
  if (job.client === 'claude' || job.client === 'gemini') {
    result.receiptSignatures = [];
    result.receiptOccurrences = [];
    for (const message of result.messages) {
      const source = emissions.get(message);
      if (!source) throw new Error('missing transcript emission provenance');
      result.receiptSignatures.push(ingestReceiptSignature(message,source));
      result.receiptOccurrences.push(source.occurrence + (job.client === 'claude' ? job.offset : 0));
    }
  }
  const after = ingestIdentity(await fs.promises.stat(job.file));
  if (!sameIngestFile(before,after) || after.size < before.size || after.size === before.size && !sameIngestSnapshot(before,after)) throw new Error('ingest source changed during read');
  if (job.walIdentity !== undefined && !sameIngestWal(job.walIdentity,await ingestWalIdentity(job.file))) throw new Error('ingest WAL changed during read');
  return validateIngestResult(result,job,checkpoint);
}
