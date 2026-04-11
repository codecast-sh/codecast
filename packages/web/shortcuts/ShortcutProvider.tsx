"use client";

import { createContext, useContext, useCallback, useRef, ReactNode } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { ShortcutAction, SHORTCUTS, matchShortcut } from "./registry";
import { onShortcutUsed } from "../tips/useTips";
import { setShortcutHandler } from "./listener";

type Handler = () => boolean | void;

interface ShortcutContextValue {
  registerAction: (action: ShortcutAction, handler: Handler) => () => void;
  setContext: (ctx: string, active: boolean) => void;
}

const ShortcutContext = createContext<ShortcutContextValue | null>(null);

function isInputTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return false;
}

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const handlersRef = useRef(new Map<ShortcutAction, Set<Handler>>());
  const contextsRef = useRef(new Set<string>());

  const registerAction = useCallback((action: ShortcutAction, handler: Handler) => {
    const map = handlersRef.current;
    if (!map.has(action)) map.set(action, new Set());
    map.get(action)!.add(handler);
    return () => {
      const set = map.get(action);
      if (set) {
        set.delete(handler);
        if (set.size === 0) map.delete(action);
      }
    };
  }, []);

  const setContext = useCallback((ctx: string, active: boolean) => {
    if (active) contextsRef.current.add(ctx);
    else contextsRef.current.delete(ctx);
  }, []);

  // Bind the keydown logic to the HMR-stable capture listener in listener.ts.
  // The listener itself is registered at module-evaluation time (before any
  // effects), so it always fires first in the capture-phase chain.
  useMountEffect(() => {
    setShortcutHandler((e: KeyboardEvent) => {
      const inInput = isInputTarget(e);

      for (const def of SHORTCUTS) {
        if (!matchShortcut(e, def)) continue;
        if (def.when && !contextsRef.current.has(def.when)) continue;
        if (inInput && !def.skipInputCheck) continue;

        const actionHandlers = handlersRef.current.get(def.action);
        if (!actionHandlers || actionHandlers.size === 0) continue;

        let handled = false;
        for (const handler of actionHandlers) {
          const result = handler();
          if (result === false) continue;
          handled = true;
          if (result === true) break;
        }
        if (handled) {
          e.preventDefault();
          e.stopImmediatePropagation();
          onShortcutUsed(def.action);
          return;
        }
      }
    });
    return () => setShortcutHandler(null);
  });

  const value: ShortcutContextValue = { registerAction, setContext };

  return (
    <ShortcutContext.Provider value={value}>
      {children}
    </ShortcutContext.Provider>
  );
}

const NOOP_CONTEXT: ShortcutContextValue = {
  registerAction: () => () => {},
  setContext: () => {},
};

export function useShortcuts(): ShortcutContextValue {
  const ctx = useContext(ShortcutContext);
  return ctx ?? NOOP_CONTEXT;
}

export function useShortcutAction(action: ShortcutAction, handler: Handler) {
  const { registerAction } = useShortcuts();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // useWatchEffect (not useMountEffect) so that when ShortcutProvider remounts
  // during HMR and produces a new registerAction, children re-register their
  // handlers in the new handlers Map instead of leaving them orphaned in the old one.
  useWatchEffect(() => {
    return registerAction(action, () => handlerRef.current());
  }, [registerAction, action]);
}

export function useShortcutContext(ctx: string, active: boolean = true) {
  const { setContext } = useShortcuts();

  useWatchEffect(() => {
    if (active) {
      setContext(ctx, true);
      return () => setContext(ctx, false);
    }
  }, [ctx, active, setContext]);
}
