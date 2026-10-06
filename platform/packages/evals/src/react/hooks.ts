// The hooks every Evals view reads through: the host, the area's addresses,
// a cached answer, the health of the connection, the client's verbs, and the
// change feed that live views follow. Each reads the nearest EvalsProvider;
// outside one a view still renders (a test mounting a view alone), with the
// default host and no data.

import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { evalsPaths, followChanges, type CachedResource, type EvalsArgs, type EvalsClient, type EvalsPaths, type EvalsResponseOf } from '../client';
import type { ChangesResponse, EvalsCapabilities, EvalsViewRoutes, HealthResponse } from '../contract';
import { EvalsContext } from './context';
import { defaultEvalsHost } from './defaults';
import type { EvalsHost } from './host';

/** The app the view renders in: the provider's host, or the plain defaults outside one. */
export function useEvalsHost(): EvalsHost {
  return useContext(EvalsContext)?.host ?? defaultEvalsHost;
}

/** Every address of the area, under the host's base path. */
export function useEvalsPaths(): EvalsPaths {
  const base = useEvalsHost().basePath;
  return useMemo(() => evalsPaths(base), [base]);
}

/** The one copy behaviour every Evals copy control shares: the host's clipboard and notice, and a check mark for a moment. */
export function useCopy(text: string): [copied: boolean, copy: () => Promise<void>] {
  const host = useEvalsHost();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await host.copy(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return [copied, copy];
}

/** `value`, once it has held still for `ms`. */
export function useDebounce<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function subscribeVisibility(fn: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', fn);
  return () => document.removeEventListener('visibilitychange', fn);
}
const documentVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/** Whether the page's document is on screen (a hidden browser tab or a minimised window is not). */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
}

const nothing = () => () => {};

/** One cached answer by its key, following the cache. */
function useCached(key: string | null): CachedResource | undefined {
  const ctx = useContext(EvalsContext);
  const subscribe = useCallback((fn: () => void) => (ctx && key ? ctx.cache.subscribe(key, fn) : () => {}), [ctx, key]);
  const read = () => (ctx && key ? ctx.cache.get(key) : undefined);
  return useSyncExternalStore(ctx && key ? subscribe : nothing, read, read);
}

const HEALTH_KEY = 'GET /health';

/** Whether the area can load: a transport, and an answer from its /health. */
function useConnected(): boolean {
  const ctx = useContext(EvalsContext);
  const health = useCached(HEALTH_KEY);
  return !!ctx?.transport && !!health?.data;
}

export interface EvalsResourceView<T> {
  data: T | null;
  error: string | null;
  /** The HTTP status of the last failure (404 for an unknown id). */
  status: number | null;
  loading: boolean;
  reload: () => void;
}

/** The one implementation behind every typed useEvalsResource: route keys are strings here, and the table only types them. */
function useResource(route: string, args: object | null): EvalsResourceView<unknown> {
  const ctx = useContext(EvalsContext);
  const key = ctx && args ? ctx.client.cacheKey(route, args as never) : null;
  const res = useCached(key);
  const connected = useConnected();
  const argsRef = useRef(args);
  argsRef.current = args;
  useEffect(() => {
    if (ctx && connected && key && argsRef.current) void ctx.client.load(route, argsRef.current as never);
  }, [ctx, connected, key, route]);
  const reload = useCallback(() => {
    if (ctx && argsRef.current) void ctx.client.load(route, argsRef.current as never, { force: true });
  }, [ctx, route]);
  return useMemo(() => ({ data: res?.data ?? null, error: res?.error ?? null, status: res?.status ?? null, loading: !res || res.loading, reload }), [res, reload]);
}

/** How the area is doing: GET /health as last read, whether it can load, the transport's kind, and the last failure to reach it. */
export function useEvalsHealth(): { health: HealthResponse | null; connected: boolean; transport: string | null; error: string | null; refresh: () => void } {
  const ctx = useContext(EvalsContext);
  const res = useCached(HEALTH_KEY);
  const health = (res?.data as HealthResponse | null | undefined) ?? null;
  const transport = ctx?.transport?.kind ?? null;
  const connected = !!ctx?.transport && !!health;
  const error = res?.error ?? null;
  const refresh = useCallback(() => {
    if (ctx?.transport) void ctx.client.load('GET /health', {} as never, { force: true });
  }, [ctx]);
  return useMemo(() => ({ health, connected, transport, error, refresh }), [health, connected, transport, error, refresh]);
}

const EVERY_CAPABILITY: EvalsCapabilities = { trends: true, freezes: true, epochs: true, attribution: true, commits: true, bisect: true, changes: true, liveness: true };

/**
 * What the product's data can fill, from GET /health. Only an explicit false
 * turns a capability off, so a server that predates capabilities (or one not
 * read yet) draws every panel, as before.
 */
export function useEvalsCapabilities(): EvalsCapabilities {
  const caps = useEvalsHealth().health?.capabilities;
  return useMemo(() => ({ ...EVERY_CAPABILITY, ...caps }), [caps]);
}

/** Every answer the area holds, by cache key: what the search can resolve without asking. */
export function useEvalsLoaded(): Record<string, CachedResource> {
  const ctx = useContext(EvalsContext);
  const empty = useMemo(() => ({}), []);
  return useSyncExternalStore(ctx ? ctx.cache.subscribeAll : nothing, ctx ? ctx.cache.loaded : () => empty, ctx ? ctx.cache.loaded : () => empty);
}

const noProvider = (): never => {
  throw new Error('evals: no EvalsProvider above this view');
};
const NO_CLIENT: EvalsClient<any> = { call: noProvider, load: noProvider, invalidate: noProvider, cacheKey: noProvider };

/** The area's verbs outside a render: `call` one route for its answer, `load` an answer into the cache, `invalidate` what a write made stale. */
function useClient(): EvalsClient<any> {
  return useContext(EvalsContext)?.client ?? NO_CLIENT;
}

/**
 * Follows GET /changes while a view shows live work, handing each answer with
 * anything new to `onChanges`. It asks only while `live`, connected and on
 * screen (the document and the host's pane), at the provider's poll policy.
 * The cursor lives as long as the view, so a view that comes back on screen
 * hears what changed while it was away.
 */
function useChanges(live: boolean, onChanges: (changes: ChangesResponse<any>) => void): void {
  const ctx = useContext(EvalsContext);
  const host = useEvalsHost();
  const paneVisible = host.useVisible();
  const docVisible = useDocumentVisible();
  const connected = useConnected();
  const pauseWhenHidden = ctx?.poll.pauseWhenHidden ?? true;
  const on = live && connected && (!pauseWhenHidden || (docVisible && paneVisible));
  const onRef = useRef(on);
  onRef.current = on;
  const handler = useRef(onChanges);
  handler.current = onChanges;
  const listeners = useRef(new Set<() => void>());
  useEffect(() => {
    for (const fn of [...listeners.current]) fn();
  }, [on]);
  useEffect(() => {
    if (!ctx) return;
    const asking = {
      visible: () => onRef.current,
      subscribe: (fn: () => void) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
    };
    return followChanges((since) => ctx.client.call('GET /changes', { query: { since } } as never) as Promise<ChangesResponse<any>>, (c) => handler.current(c), { ...ctx.poll, pauseWhenHidden: true }, asking);
  }, [ctx]);
}

/** The hooks typed by a route table: the neutral one by default, or a host's wider one (codecast: evalsHooks<EvalsRoutes>()). One implementation; the table only types it. */
export function evalsHooks<T = EvalsViewRoutes>() {
  return {
    useEvalsResource: useResource as <K extends keyof T & string>(key: K, args: EvalsArgs<T, K> | null) => EvalsResourceView<EvalsResponseOf<T, K>>,
    useEvalsClient: useClient as () => EvalsClient<T>,
    useEvalsChanges: useChanges as (live: boolean, onChanges: (changes: EvalsResponseOf<T, 'GET /changes' & keyof T>) => void) => void,
  };
}

/** The answer to one neutral route, loaded once the area is connected and cached by its request. `null` args skip the load. */
export const { useEvalsResource, useEvalsClient, useEvalsChanges } = evalsHooks<EvalsViewRoutes>();
