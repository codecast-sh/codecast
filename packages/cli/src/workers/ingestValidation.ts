import { validateIngestBounds } from './ingestTransport.js';
import type { IngestJob, IngestResult } from './ingestTypes.js';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
function requireValue(valid: unknown): asserts valid {
  if (!valid) throw new Error('invalid ingest result schema');
}
function fields(value: unknown, allowed: string[]): asserts value is Record<string, any> {
  requireValue(object(value));
  for (const key in value) requireValue(Object.hasOwn(value,key) && allowed.includes(key));
}
function strings(value: Record<string, any>, names: string[]): void {
  for (const key of names) requireValue(value[key] === undefined || typeof value[key] === 'string');
}
function* message(value: unknown): Generator<void> {
  fields(value,['uuid','role','content','timestamp','thinking','toolCalls','toolResults','images','subtype','stopReason','model']);
  requireValue(['user','assistant','system'].includes(value.role) && typeof value.content === 'string' && Number.isFinite(value.timestamp));
  strings(value,['uuid','thinking','subtype','stopReason','model']);
  for (const key of ['toolCalls','toolResults','images']) requireValue(value[key] === undefined || Array.isArray(value[key]));
  for (const call of value.toolCalls ?? []) {
    fields(call,['id','name','input']);
    requireValue(typeof call.id === 'string' && typeof call.name === 'string' && object(call.input));
    yield;
  }
  for (const result of value.toolResults ?? []) {
    fields(result,['toolUseId','content','isError']);
    requireValue(typeof result.toolUseId === 'string' && typeof result.content === 'string' && (result.isError === undefined || typeof result.isError === 'boolean'));
    yield;
  }
  for (const image of value.images ?? []) {
    fields(image,['mediaType','data','localPath','toolUseId']);
    strings(image,['data','localPath','toolUseId']);
    requireValue(typeof image.mediaType === 'string' && (typeof image.data === 'string') !== (typeof image.localPath === 'string'));
    yield;
  }
  yield;
}
function codex(value: unknown): void {
  fields(value,['id','parentThreadId','originator','source']);
  strings(value,['id','parentThreadId','originator']);
  if (value.source === undefined || typeof value.source === 'string') return;
  const source = value.source;
  fields(source,['subagent','custom']);
  strings(source,['custom']);
  if (source.subagent === undefined || typeof source.subagent === 'string') return;
  fields(source.subagent,['thread_spawn']);
  if (source.subagent.thread_spawn === undefined) return;
  const spawn = source.subagent.thread_spawn;
  fields(spawn,['parent_thread_id','depth','agent_path','agent_nickname']);
  strings(spawn,['parent_thread_id','agent_path','agent_nickname']);
  requireValue(spawn.depth === undefined || Number.isSafeInteger(spawn.depth) && spawn.depth >= 0);
}
function* schema(value: unknown, job: IngestJob): Generator<void> {
  fields(value,['messages','bytesConsumed','fileSize','totalCount','maxRowId','model','signatures','receiptSignatures','receiptOccurrences','messageTitles','handoffParents','metadata']);
  requireValue(Array.isArray(value.messages));
  for (const key of ['bytesConsumed','fileSize','totalCount','maxRowId']) requireValue(Number.isSafeInteger(value[key]) && value[key] >= 0);
  requireValue(value.fileSize === job.identity.size);
  const windowed = ['claude','cursor','codex'].includes(job.client);
  requireValue(windowed ? value.bytesConsumed <= Math.max(0,job.identity.size-job.offset) : value.bytesConsumed === 0);
  if (job.client === 'cursorDb') requireValue(value.messages.length === Math.max(0,value.totalCount-job.offset) && (value.maxRowId !== 0 || value.totalCount === 0));
  else requireValue(value.totalCount === value.messages.length && value.maxRowId === 0);
  if (windowed) requireValue(value.bytesConsumed > 0 || value.messages.length === 0);
  requireValue(value.model === undefined || job.client === 'codex' && typeof value.model === 'string');
  for (const key of ['signatures','messageTitles','handoffParents']) requireValue(Array.isArray(value[key]) && value[key].length === value.messages.length);
  requireValue(['cursor','claude','gemini'].includes(job.client) ? Array.isArray(value.receiptSignatures) && value.receiptSignatures.length === value.messages.length : value.receiptSignatures === undefined);
  requireValue(['claude','gemini'].includes(job.client) ? Array.isArray(value.receiptOccurrences) && value.receiptOccurrences.length === value.messages.length : value.receiptOccurrences === undefined);
  for (let i=0;i<value.messages.length;i++) {
    if (value.receiptOccurrences) {
      const occurrence = value.receiptOccurrences[i];
      requireValue(Number.isSafeInteger(occurrence) && occurrence >= (job.client === 'claude' ? job.offset : 0) && occurrence < (job.client === 'claude' ? job.offset + value.bytesConsumed : job.identity.size));
      requireValue(i === 0 || occurrence > value.receiptOccurrences[i-1]);
    }
    yield* message(value.messages[i]);
    requireValue(typeof value.signatures[i] === 'string' && /^[0-9a-f]{64}$/.test(value.signatures[i]));
    if (value.receiptSignatures) requireValue(typeof value.receiptSignatures[i] === 'string' && /^[0-9a-f]{64}$/.test(value.receiptSignatures[i]));
    requireValue(value.messageTitles[i] === null || typeof value.messageTitles[i] === 'string');
    requireValue(value.handoffParents[i] === null || typeof value.handoffParents[i] === 'string' && (value.handoffParents[i] === '' || /^[0-9a-f-]{36}$/.test(value.handoffParents[i])));
  }
  const meta = value.metadata;
  fields(meta,['slug','parentUuid','cwd','cliFlags','summaryTitle','headMessages','teamInfo','planTools','subagent','appServerHead','codex','forkRoot','completedReview','backupAttempted','title','parentSessionId','agentName','internal','sessionExists','turn','permissionPrompt','warnings']);
  strings(meta,['slug','parentUuid','cwd','summaryTitle','appServerHead','forkRoot','title','parentSessionId','agentName']);
  requireValue(meta.cliFlags === undefined || meta.cliFlags === null || typeof meta.cliFlags === 'string');
  for (const key of ['completedReview','backupAttempted','internal']) requireValue(meta[key] === undefined || typeof meta[key] === 'boolean');
  requireValue(meta.sessionExists === undefined || job.client === 'opencode' && typeof meta.sessionExists === 'boolean');
  requireValue(meta.turn === undefined || ['active','idle','unknown'].includes(meta.turn));
  requireValue(Array.isArray(meta.warnings));
  for (const warning of meta.warnings) { requireValue(typeof warning === 'string'); yield; }
  requireValue(meta.headMessages === undefined || Array.isArray(meta.headMessages) && meta.headMessages.length <= 3);
  for (const head of meta.headMessages ?? []) yield* message(head);
  if (meta.teamInfo !== undefined) {
    fields(meta.teamInfo,['teamName','agentName']);
    requireValue(typeof meta.teamInfo.teamName === 'string' && typeof meta.teamInfo.agentName === 'string');
  }
  requireValue(meta.planTools === undefined || Array.isArray(meta.planTools));
  for (const tool of meta.planTools ?? []) {
    fields(tool,['name','input','occurrence']);
    requireValue(['ExitPlanMode','TaskCreate','TaskUpdate'].includes(tool.name) && object(tool.input) && typeof tool.occurrence === 'string' && /^[0-9a-f]{64}$/.test(tool.occurrence));
    yield;
  }
  if (meta.subagent !== undefined) { fields(meta.subagent,['description','agentType']); strings(meta.subagent,['description','agentType']); }
  if (meta.codex !== undefined) codex(meta.codex);
  if (meta.permissionPrompt !== undefined && meta.permissionPrompt !== null) {
    fields(meta.permissionPrompt,['tool_name','arguments_preview']);
    requireValue(typeof meta.permissionPrompt.tool_name === 'string' && typeof meta.permissionPrompt.arguments_preview === 'string');
  }
}
export async function validateIngestResult(value: unknown, job: IngestJob, checkpoint: () => void = () => {}): Promise<IngestResult> {
  await validateIngestBounds(value,checkpoint);
  let count = 0;
  for (const _ of schema(value,job)) {
    if (++count % 128 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); checkpoint(); }
  }
  checkpoint();
  return value as IngestResult;
}
