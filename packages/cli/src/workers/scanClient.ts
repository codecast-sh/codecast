import { scanWorkerHost } from './bridge.js';
import { WorkerUnavailable, WorkerOperationError } from './host.js';
import type { ScanJob, ScanPage, ScanRow } from './scanTypes.js';
export class ScanCancelled extends Error {}
export const yieldScanBatch = () => new Promise<void>(resolve => setImmediate(resolve));
export async function visitScan(job: ScanJob, visit: (rows: ScanRow[]) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
  const host = scanWorkerHost();
  if (!host) throw new WorkerUnavailable('scan disabled');
  let cursor: string | undefined;
  try {
    let page: ScanPage;
    do {
      if (signal?.aborted || host.state.closed) throw new ScanCancelled('scan stopped');
      page = await host.request('scan', cursor ? {action:'next',cursor} : {action:'open',job}, {timeoutMs:60_000,signal}) as ScanPage;
      if (cursor && page.cursor !== cursor) throw new WorkerUnavailable('wrong scan cursor');
      cursor = page.done ? undefined : page.cursor;
      if (signal?.aborted || host.state.closed) throw new ScanCancelled('scan stopped');
      await visit(page.rows);
      await yieldScanBatch();
    } while (!page.done);
  } catch (error) {
    if (signal?.aborted || host.state.closed) throw new ScanCancelled('scan stopped');
    throw error;
  } finally {
    if (cursor && !host.state.closed && host.state.pid !== null) {
      await host.request('scan',{action:'close',cursor},{timeoutMs:1000}).catch(() => {});
    }
  }
}
export function scanCanFallback(error: unknown): boolean {
  return error instanceof WorkerUnavailable || error instanceof WorkerOperationError && ['busy','operation_failed'].includes(error.message);
}
export async function collectScan(job: ScanJob, signal?: AbortSignal): Promise<ScanRow[]> {
  const rows: ScanRow[]=[];
  await visitScan(job,batch => { rows.push(...batch); },signal);
  return rows;
}
