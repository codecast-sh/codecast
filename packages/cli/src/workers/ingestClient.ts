import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ingestWorkerHost } from './bridge.js';
import { WorkerUnavailable } from './host.js';
import { yieldScanBatch } from './scanClient.js';
import { IngestAssembler } from './ingestTransport.js';
import { readIngestJob, ingestIdentity, sameIngestFile, sameIngestSnapshot, ingestWalIdentity, sameIngestWal } from './ingestJobs.js';
import type { IngestJob, IngestPage, IngestResult } from './ingestTypes.js';
export { ingestIdentity, sameIngestFile, sameIngestSnapshot };
const ingestSources = new WeakMap<object, IngestJob>();
const ingestRecords = new WeakMap<object, {key:string;signature:string;file:string;identity:string;offset:number;client:string}>();
export const ingestRecord = (message: object) => ingestRecords.get(message);
async function rememberIngest(result: IngestResult, job: IngestJob): Promise<IngestResult> {
  if (!result.signatures || result.signatures.length !== result.messages.length) throw new Error('invalid ingest signatures');
  for (let i=0;i<result.messages.length;i++) {
    const signature = result.receiptSignatures?.[i] ?? result.signatures[i];
    if (!/^[0-9a-f]{64}$/.test(signature)) throw new Error('invalid ingest signature');
    const msg=result.messages[i];
    const key=JSON.stringify([job.client,job.sessionId,job.file,job.identity.dev,job.identity.ino,job.identity.birthtimeMs,msg.uuid ? ['uuid',msg.uuid] : [job.offset,i]]);
    ingestRecords.set(msg,{key,signature,file:job.file,offset:job.offset,client:job.client,identity:JSON.stringify([job.identity.dev,job.identity.ino,job.identity.birthtimeMs])});
    if (i % 128 === 127) await yieldScanBatch();
  }
  ingestSources.set(result, job);
  return result;
}
export class IngestCancelled extends Error {}
export async function validateTranscriptIngest(result: object): Promise<void> {
  const job = ingestSources.get(result);
  if (!job) throw new Error('unknown ingest source');
  const after = ingestIdentity(await fs.promises.stat(job.file));
  if (!sameIngestFile(job.identity, after) || after.size < job.identity.size || after.size === job.identity.size && !sameIngestSnapshot(job.identity, after)) throw new Error('ingest source changed before position commit');
  if (job.walIdentity !== undefined && !sameIngestWal(job.walIdentity, await ingestWalIdentity(job.file))) throw new Error('ingest WAL changed before position commit');
}
export async function readTranscriptIngest(input: Omit<IngestJob,'identity' | 'generation' | 'walIdentity'>, options: {signal?: AbortSignal; timeoutMs?: number} = {}): Promise<IngestResult> {
  const job: IngestJob = {...input,generation:randomUUID(),identity:ingestIdentity(await fs.promises.stat(input.file)),...(['cursorDb','opencode'].includes(input.client) ? {walIdentity:await ingestWalIdentity(input.file)} : {})};
  const host = ingestWorkerHost();
  const current = () => {
    if (options.signal?.aborted || host && (host.state.closed || ingestWorkerHost() !== host)) throw new IngestCancelled('ingest stopped');
  };
  const finish = async (result: IngestResult) => {
    if (!result || !Array.isArray(result.messages) || !result.metadata || !Array.isArray(result.metadata.warnings) || !Number.isSafeInteger(result.bytesConsumed) || result.bytesConsumed < 0 || result.bytesConsumed > Math.max(0,job.identity.size-job.offset) || result.fileSize !== job.identity.size || !Number.isSafeInteger(result.maxRowId) || result.maxRowId < 0 || !result.metadata.warnings.every(w=>typeof w === 'string') || !Number.isSafeInteger(result.totalCount) || result.totalCount < 0) throw new Error('invalid ingest result');
    for (let i=0;i<result.messages.length;i++) {
      const m=result.messages[i];
      if (!m || !['user','assistant','system'].includes(m.role) || typeof m.content !== 'string' || !Number.isFinite(m.timestamp)) throw new Error('invalid ingest message');
      if (i % 128 === 127) { await yieldScanBatch(); current(); }
    }
    await rememberIngest(result,job);
    const after = ingestIdentity(await fs.promises.stat(job.file));
    if (!sameIngestFile(job.identity,after) || after.size < job.identity.size || after.size === job.identity.size && !sameIngestSnapshot(job.identity,after)) throw new Error('ingest source changed before application');
    if (job.walIdentity !== undefined && !sameIngestWal(job.walIdentity,await ingestWalIdentity(job.file))) throw new Error('ingest WAL changed before application');
    current();
    return result;
  };
  current();
  if (!host) return finish(await readIngestJob(job));
  let cursor: string | undefined, sequence = 0, closeSequence = 0, hostGeneration: number | undefined;
  const assembler = new IngestAssembler();
  try {
    for (;;) {
      current();
      const page = await host.request('ingest',cursor ? {action:'next',cursor,generation:job.generation,sequence} : {action:'open',job},{timeoutMs:options.timeoutMs ?? 60_000,signal:options.signal}) as IngestPage;
      closeSequence = sequence + 1;
      if (!cursor) { cursor = page.cursor; hostGeneration = host.state.generation; }
      current();
      if (hostGeneration !== undefined && hostGeneration !== host.state.generation || page.generation !== job.generation || page.sequence !== sequence || cursor && page.cursor !== cursor) throw new Error('ingest response identity mismatch');
      hostGeneration = host.state.generation;
      cursor = page.cursor; sequence++;
      assembler.push(page.tokens);
      await yieldScanBatch();
      if (page.done) { cursor = undefined; break; }
    }
    const result = assembler.finish() as IngestResult;
    return finish(result);
  } catch (error) {
    current();
    if (!(error instanceof WorkerUnavailable) || job.identity.size > 256 * 1024 || ['cursorDb','opencode'].includes(job.client) || job.recoverBackup) throw error;
    const result = await readIngestJob(job);
    current();
    return finish(result);
  } finally {
    if (cursor && !host.state.closed && host.state.pid !== null && host.state.generation === hostGeneration) {
      await host.request('ingest',{action:'close',cursor,generation:job.generation,sequence:closeSequence},{timeoutMs:1000}).catch(() => {});
    }
  }
}
const fileTails = new Map<string, Promise<void>>();
export async function serializeTranscript<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = fileTails.get(key);
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  fileTails.set(key,tail);
  try { await before; return await run(); }
  finally { release(); if (fileTails.get(key) === tail) fileTails.delete(key); }
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
