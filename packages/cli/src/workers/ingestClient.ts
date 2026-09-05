import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { ingestWorkerHost } from './bridge.js';
import { WorkerUnavailable } from './host.js';
import { yieldScanBatch } from './scanClient.js';
import { IngestAssembler, ingestRetainedWeight } from './ingestTransport.js';
import { readIngestJob, ingestIdentity, sameIngestFile, sameIngestSnapshot, ingestWalIdentity, sameIngestWal } from './ingestJobs.js';
import { validIngestPage, type IngestJob, type IngestPage, type IngestResult } from './ingestTypes.js';
import { validateIngestResult } from './ingestValidation.js';
import { IngestDeadline, IngestCancelled, currentTranscriptDeadline, checkTranscriptDeadline, withTranscriptDeadline, waitForTranscriptReservation } from './ingestDeadline.js';
import { MAX_QUEUE, MAX_INFLIGHT, MAX_DEADLINE_MS } from './protocol.js';
export { IngestCancelled, IngestDeadlineExceeded } from './ingestDeadline.js';
export { ingestIdentity, sameIngestFile, sameIngestSnapshot };
const ingestSources = new WeakMap<object, IngestJob>();
export const ingestSource = (result: object): Readonly<IngestJob> | undefined => ingestSources.get(result);
const ingestRecords = new WeakMap<object, {key:string;signature:string;file:string;identity:string;offset:number;client:string;weight:number;sourceSize:number;title?:string;handoffParent?:string}>();
export const ingestRecord = (message: object) => ingestRecords.get(message);
export const ingestMessageTitle = (message: object) => ingestRecords.get(message)?.title;
async function rememberIngest(result: IngestResult, job: IngestJob, checkpoint: () => void): Promise<IngestResult> {
  if (!result.handoffParents || result.handoffParents.length !== result.messages.length || !result.handoffParents.every(parent => parent === null || typeof parent === 'string' && (parent === '' || /^[0-9a-f-]{36}$/.test(parent)))) throw new Error('invalid ingest handoff facts');
  if (!result.messageTitles || result.messageTitles.length !== result.messages.length || !result.messageTitles.every(title => title === null || typeof title === 'string')) throw new Error('invalid ingest message titles');
  if (!result.signatures || result.signatures.length !== result.messages.length) throw new Error('invalid ingest signatures');
  for (let i=0;i<result.messages.length;i++) {
    const signature = result.receiptSignatures?.[i] ?? result.signatures[i];
    if (!/^[0-9a-f]{64}$/.test(signature)) throw new Error('invalid ingest signature');
    const msg=result.messages[i];
    const hash=createHash('sha256').update(JSON.stringify([job.client,job.sessionId,job.file,job.identity.dev,job.identity.ino,job.identity.birthtimeMs,msg.uuid ? ['uuid',msg.uuid.length] : job.client === 'cursorDb' ? [job.offset+i] : [job.offset,i]]));
    if(msg.uuid)for(let offset=0;offset<msg.uuid.length;offset+=8192){
      hash.update(Buffer.from(msg.uuid.slice(offset,offset+8192),'utf16le'));
      if(offset%1_048_576===0){await yieldScanBatch();checkpoint();}
    }
    const key=hash.digest('hex');
    ingestRecords.set(msg,{key,signature,weight:await ingestRetainedWeight(msg,checkpoint),sourceSize:job.identity.size,title:result.messageTitles[i] ?? undefined,handoffParent:result.handoffParents[i] ?? undefined,file:job.file,offset:job.offset,client:job.client,identity:JSON.stringify([job.identity.dev,job.identity.ino,job.identity.birthtimeMs])});
    if (i % 128 === 127) await yieldScanBatch();
  }
  ingestSources.set(result, job);
  return result;
}
export async function validateTranscriptIngest(result: object): Promise<void> {
  checkTranscriptDeadline();
  const job = ingestSources.get(result);
  if (!job) throw new Error('unknown ingest source');
  const after = ingestIdentity(await fs.promises.stat(job.file));
  if (!sameIngestFile(job.identity, after) || after.size < job.identity.size || after.size === job.identity.size && !sameIngestSnapshot(job.identity, after)) throw new Error('ingest source changed before position commit');
  if (job.walIdentity !== undefined && !sameIngestWal(job.walIdentity, await ingestWalIdentity(job.file))) throw new Error('ingest WAL changed before position commit');
  checkTranscriptDeadline();
}
export async function readTranscriptIngest(input: Omit<IngestJob,'identity' | 'generation' | 'walIdentity'>, options: {signal?: AbortSignal; timeoutMs?: number} = {}): Promise<IngestResult> {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_DEADLINE_MS)) throw new Error('invalid ingest deadline');
  const parent = currentTranscriptDeadline();
  const signal = parent && options.signal ? AbortSignal.any([parent.signal,options.signal]) : parent?.signal ?? options.signal;
  const budget = new IngestDeadline(Math.min(options.timeoutMs ?? MAX_DEADLINE_MS,parent?.remaining() ?? MAX_DEADLINE_MS),signal);
  const host = ingestWorkerHost();
  const current = () => {
    budget.check();
    if (host && (host.state.closed || ingestWorkerHost() !== host)) throw new IngestCancelled('ingest stopped');
  };
  let cursor: string | undefined, sequence = 0, closeSequence = 0, hostGeneration: number | undefined;
  let job: IngestJob | undefined;
  try {
    current();
    job = {...input,generation:randomUUID(),identity:ingestIdentity(await fs.promises.stat(input.file)),...(['cursorDb','opencode'].includes(input.client) ? {walIdentity:await ingestWalIdentity(input.file)} : {})};
    current();
    const capturedJob = job;
    const finish = async (value: unknown) => {
      const result = await validateIngestResult(value,capturedJob,current);
      const after = ingestIdentity(await fs.promises.stat(capturedJob.file));
      current();
      if (!sameIngestFile(capturedJob.identity,after) || after.size < capturedJob.identity.size || after.size === capturedJob.identity.size && !sameIngestSnapshot(capturedJob.identity,after)) throw new Error('ingest source changed before application');
      if (capturedJob.walIdentity !== undefined && !sameIngestWal(capturedJob.walIdentity,await ingestWalIdentity(capturedJob.file))) throw new Error('ingest WAL changed before application');
      current();
      await rememberIngest(result,capturedJob,current);
      current();
      return result;
    };
    if (!host) return await finish(await readIngestJob(job,current));
    const assembler = new IngestAssembler();
    try {
      for (;;) {
        current();
        const page = await host.request('ingest',cursor ? {action:'next',cursor,generation:job.generation,sequence} : {action:'open',job},{timeoutMs:budget.remaining(),signal:budget.signal}) as IngestPage;
        closeSequence = sequence + 1;
        if (!cursor) { cursor = page.cursor; hostGeneration = host.state.generation; }
        current();
        if (!validIngestPage(page)) throw new Error('invalid ingest page or no progress');
        if (hostGeneration !== undefined && hostGeneration !== host.state.generation || page.generation !== job.generation || page.sequence !== sequence || cursor && page.cursor !== cursor) throw new Error('ingest response identity mismatch');
        hostGeneration = host.state.generation;
        cursor = page.cursor; sequence++;
        assembler.push(page.tokens);
        await yieldScanBatch();
        current();
        if (page.done) { cursor = undefined; break; }
      }
      return await finish(assembler.finish());
    } catch (error) {
      current();
      if (!(error instanceof WorkerUnavailable) || job.identity.size > 256 * 1024 || ['cursorDb','opencode'].includes(job.client) || job.recoverBackup) throw error;
      const result = await readIngestJob(job,current);
      current();
      return await finish(result);
    }
  } finally {
    try {
      if (cursor && job && host && !host.state.closed && host.state.pid !== null && host.state.generation === hostGeneration) {
        await host.request('ingest',{action:'close',cursor,generation:job.generation,sequence:closeSequence},{timeoutMs:1000}).catch(() => {});
      }
    } finally { budget.dispose(); }
  }
}
const fileTails = new Map<string, Promise<void>>();
let transcriptReservations = 0;
export async function serializeTranscript<T>(key: string, run: () => Promise<T>, options: {signal?: AbortSignal; timeoutMs?: number} = {}): Promise<T> {
  const inherited = currentTranscriptDeadline();
  return withTranscriptDeadline(async () => {
    const deadline = currentTranscriptDeadline()!;
    deadline.check();
    if (!inherited && transcriptReservations >= MAX_QUEUE + MAX_INFLIGHT) throw new Error('ingest reservation capacity');
    if (!inherited) transcriptReservations++;
    const before = fileTails.get(key);
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    fileTails.set(key,tail);
    let entered = false;
    const retire = () => {
      if (!inherited) transcriptReservations--;
      release();
      if (fileTails.get(key) === tail) fileTails.delete(key);
    };
    try {
      await waitForTranscriptReservation(before,deadline);
      entered = true;
      deadline.check();
      const result = await run();
      deadline.check();
      return result;
    } finally {
      if (entered || !before) retire();
      else void before.then(retire);
    }
  },options);
}
export async function computeIngestSyncDelta<T extends {uuid?: string}>(messages: T[], signatures: string[], synced: ReadonlyMap<string,string>): Promise<{newMessages:T[];orphanUuids:string[];nextSynced:Map<string,string>}> {
  if (signatures.length !== messages.length) throw new Error('invalid ingest signatures');
  const nextSynced = new Map<string,string>(), newMessages:T[] = [], orphanUuids:string[] = [];
  for (let i=0;i<messages.length;i++) {
    const m=messages[i],sig=signatures[i];
    if (!/^[0-9a-f]{64}$/.test(sig)) throw new Error('invalid ingest signature');
    if (!m.uuid) newMessages.push(m);
    else { nextSynced.set(m.uuid,sig); if (synced.get(m.uuid) !== sig) newMessages.push(m); }
    if (i % 128 === 127) await yieldScanBatch();
  }
  let checked = 0;
  for (const uuid of synced.keys()) {
    if (!nextSynced.has(uuid)) orphanUuids.push(uuid);
    if (++checked % 128 === 0) await yieldScanBatch();
  }
  return {newMessages,orphanUuids,nextSynced};
}
