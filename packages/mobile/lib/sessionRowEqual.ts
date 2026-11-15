import { rowSigExcluding } from '@codecast/web/store/wakeSig';
import { agentStatusAt } from '@codecast/web/lib/liveness';

// Row fields that move on every daemon beat or model call without changing
// anything a row draws by themselves. The heartbeat's one visible effect, the
// trusted status at this instant, is compared on its own below.
const LIVENESS_ONLY_ROW_FIELDS = new Set([
  'last_heartbeat',
  'daemon_alive_until',
  'producing_until',
  'context_tokens',
  'last_model_call_at',
]);

type Row = Record<string, any>;

/** Whether two versions of a session row draw the same inbox row at `now`.
 *  The liveness overlay hands every live row a new object on each beat, so a
 *  memoized row compared by reference re-rendered every live session in every
 *  mounted list whenever the list rebuilt. */
export function sessionRowRenderEqual(a: Row, b: Row, now: number): boolean {
  if (a === b) return true;
  return rowSigExcluding(a, LIVENESS_ONLY_ROW_FIELDS) === rowSigExcluding(b, LIVENESS_ONLY_ROW_FIELDS)
    && agentStatusAt(a, now) === agentStatusAt(b, now);
}

/** memo() comparator for a row component whose `session` prop is a session
 *  row: every other prop by identity, the session by what it draws. */
export function sessionRowPropsEqual<P extends { session: Row }>(prev: P, next: P): boolean {
  for (const key in next) {
    if (key === 'session') continue;
    if (!Object.is(prev[key], next[key])) { (globalThis as any).__rowDiff = (globalThis as any).__rowDiff ?? {}; (globalThis as any).__rowDiff[key] = ((globalThis as any).__rowDiff[key] ?? 0) + 1; return false; }
  }
  for (const key in prev) if (!(key in next)) return false;
  const eq = sessionRowRenderEqual(prev.session, next.session, Date.now());
  if (!eq) { const g = globalThis as any; g.__rowDiff = g.__rowDiff ?? {}; const a = prev.session as any, b = next.session as any; let hit = false; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (LIVENESS_ONLY_ROW_FIELDS.has(k)) continue; if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { hit = true; g.__rowDiff['s.' + k] = (g.__rowDiff['s.' + k] ?? 0) + 1; } } if (!hit) g.__rowDiff['s.status'] = (g.__rowDiff['s.status'] ?? 0) + 1; }
  return eq;
}
