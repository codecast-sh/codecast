// The root of the shared Evals views in a host. It owns this mount's client
// and cache (memory only unless the host hands its own), reads GET /health
// whenever a transport arrives, and hands every view the host's slots, with
// the plain defaults filling whatever the host left out.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EVALS_POLL, createEvalsClient, memoryResourceCache, type EvalsResourceCache, type EvalsTransport, type PollPolicy } from '../client';
import { EvalsContext, trackCache, type EvalsContextValue } from './context';
import { resolveEvalsHost } from './defaults';
import type { EvalsHostInput } from './host';

export interface EvalsProviderProps {
  /** Where requests go. Null while the host is still finding its data; the views wait, and the connection screen says so. */
  transport: EvalsTransport | null;
  /** Where answers are kept. Defaults to a cache in this provider's memory; a host may pass its own store, which must not persist either. */
  cache?: EvalsResourceCache;
  /** The host's slots. Read once per value: pass a constant, or memoize it. */
  host?: EvalsHostInput;
  /** How live views follow GET /changes. Defaults to every 3 s, paused while hidden. */
  poll?: PollPolicy;
  /** Every failed call, before the view sees it: where a host decides whether the whole area is out of reach. */
  onFailure?(e: unknown): void;
  children: ReactNode;
}

export function EvalsProvider({ transport, cache, host, poll = EVALS_POLL, onFailure, children }: EvalsProviderProps) {
  const [ownCache] = useState(memoryResourceCache);
  const tracked = useMemo(() => trackCache(cache ?? ownCache), [cache, ownCache]);
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const failureRef = useRef(onFailure);
  failureRef.current = onFailure;
  const client = useMemo(() => createEvalsClient({ transport: () => transportRef.current, cache: tracked, onFailure: (e) => failureRef.current?.(e) }), [tracked]);
  const resolved = useMemo(() => resolveEvalsHost(host), [host]);

  // Each transport answers its own /health: the views load once it has.
  useEffect(() => {
    if (transport) void client.load('GET /health', {} as never, { force: true });
  }, [transport, client]);

  const value = useMemo<EvalsContextValue>(() => ({ host: resolved, client, cache: tracked, transport, poll }), [resolved, client, tracked, transport, poll]);
  return <EvalsContext.Provider value={value}>{children}</EvalsContext.Provider>;
}
