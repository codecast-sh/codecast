import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readCompleteLines, cursorPassBoundary } from '../transcriptWindow.js';
import { readCodexModelBeforeOffset } from '../codexTranscriptModel.js';
import { parseTranscriptFor, parseCodexSessionFile, parseSessionFile, extractSlug, extractParentUuid, extractCwd, extractCodexCwd, extractSummaryTitle, extractTeamInfo, detectCliFlags, extractCodexSessionMetadata, extractCodexForkRoot, isCompletedStandaloneCodexReview, isCompletedNativeCodexReviewChild, extractPiCwd, extractGrokCwd, isGrokInternalSession } from '../parser.js';
import { recoverImagesFromBackup, classifyOpencodeTranscriptTail, classifyPiTranscriptTail, classifyGrokTranscriptTail } from './ingestMetadata.js';
import { INGEST_MAX_BYTES, type IngestJob, type IngestIdentity, type IngestResult } from './ingestTypes.js';
export function ingestIdentity(s: fs.Stats): IngestIdentity {
  return {dev:s.dev,ino:s.ino,birthtimeMs:s.birthtimeMs,ctimeMs:s.ctimeMs,mtimeMs:s.mtimeMs,size:s.size};
}
export function sameIngestFile(a: IngestIdentity, b: IngestIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}
export function sameIngestSnapshot(a: IngestIdentity, b: IngestIdentity): boolean {
  return sameIngestFile(a,b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
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
  if ((await fs.promises.stat(file)).size > INGEST_MAX_BYTES) throw new Error('ingest source resource limit');
  return fs.promises.readFile(file,'utf8');
}
async function windowFor(job: IngestJob, before: IngestIdentity) {
  const fd = await fs.promises.open(job.file,'r');
  try {
    if (!sameIngestSnapshot(before,ingestIdentity(await fd.stat()))) throw new Error('ingest handle changed');
    const available = Math.max(0,before.size-job.offset), limited = Math.min(available,INGEST_MAX_BYTES);
    const result = await readCompleteLines(fd,job.offset,limited,job.client === 'cursor' ? {boundary:(buf,len,eof,from) => cursorPassBoundary(buf,len,eof && limited === available,from)} : undefined);
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
async function codexHead(file: string): Promise<string> {
  const content = await readPart(file,16 * 1024 * 1024);
  let cut = 0;
  for (const line of content.split('\n')) {
    if (line.trim() && !line.includes('"type":"session_meta"')) break;
    cut += line.length + 1;
  }
  return content.slice(0,cut);
}
export async function readIngestJob(job: IngestJob): Promise<IngestResult> {
  const before = ingestIdentity(await fs.promises.stat(job.file));
  if (!sameIngestSnapshot(before,job.identity)) throw new Error('ingest source changed before read');
  const result: IngestResult = {messages:[],bytesConsumed:0,fileSize:before.size,totalCount:0,maxRowId:0,metadata:{warnings:[]}};
  const meta = result.metadata;
  let content = '';
  if (job.client === 'cursorDb') {
    const {extractMessagesFromCursorDb} = await import('../cursorProcessor.js');
    Object.assign(result,extractMessagesFromCursorDb(job.file,job.offset));
  } else if (job.client === 'opencode') {
    const {assembleOpencodeSession,resolveOpencodeSessionCwd,readOpencodeSessionLineage} = await import('../opencodeStorage.js');
    content = assembleOpencodeSession(job.sessionId,job.file) ?? '';
    if (content) {
      result.messages = parseTranscriptFor('opencode',content);
      meta.cwd = resolveOpencodeSessionCwd(job.sessionId,job.file);
      Object.assign(meta,readOpencodeSessionLineage(job.sessionId,job.file));
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
        const state = {model:job.modelKnown ? job.model : await readCodexModelBeforeOffset(job.file,job.offset)};
        result.messages = parseCodexSessionFile(content,state); result.model = state.model;
      } else result.messages = parseTranscriptFor(job.client,content);
    }
    if (job.client === 'claude') {
      if (job.recoverBackup && fs.existsSync(job.file+'.bak')) {
        if ((await fs.promises.stat(job.file+'.bak')).size > INGEST_MAX_BYTES) throw new Error('ingest backup resource limit');
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
      for (const line of content.split('\n')) {
        if (!line.includes('ExitPlanMode') && !line.includes('TaskCreate') && !line.includes('TaskUpdate')) continue;
        const entry = JSON.parse(line), message = entry.message ?? entry;
        if (Array.isArray(message.content)) for (const block of message.content) {
          if (block.type === 'tool_use' && ['ExitPlanMode','TaskCreate','TaskUpdate'].includes(block.name)) meta.planTools.push({name:block.name,input:block.input});
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
      const head = await codexHead(job.file);
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
  if (job.client === 'pi' || job.client === 'grok') result.signatures = result.messages.map(m => createHash('sha256').update(JSON.stringify(m)).digest('hex'));
  const after = ingestIdentity(await fs.promises.stat(job.file));
  if (!sameIngestFile(before,after) || after.size < before.size || after.size === before.size && !sameIngestSnapshot(before,after)) throw new Error('ingest source changed during read');
  return result;
}
