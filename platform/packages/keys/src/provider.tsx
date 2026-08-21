// The React binding of the catalog runtime. createShortcutProvider takes a
// catalog plus dispatch options and returns the provider component and its
// hooks, all typed to the app's action union. The keydown logic itself lives
// in dispatch.ts (non-React, testable without rendering); this file only wires
// it to React context and the HMR-stable capture listener.

import { createContext, useContext, useCallback, useEffect, useRef, ReactNode, ReactElement } from "react";
import { ShortcutCatalog } from "./catalog";
import { ShortcutDispatcher, ShortcutHandler, KeydownOptions, createKeydownHandler } from "./dispatch";
import { setShortcutHandler } from "./listener";

export interface ShortcutContextValue<A extends string> {
  registerAction: (action: A, handler: ShortcutHandler) => () => void;
  setContext: (ctx: string, active: boolean) => void;
  // Programmatic fire of an action's registered handlers — a command palette
  // routes its command rows through this so a palette row and its keyboard
  // chord share ONE handler. Same decline semantics as the key path (a handler
  // returning false passes to the next); returns whether anyone handled it.
  dispatchAction: (action: A) => boolean;
}

export interface ShortcutProviderKit<A extends string> {
  ShortcutProvider: (props: { children: ReactNode }) => ReactElement;
  useShortcuts: () => ShortcutContextValue<A>;
  useShortcutAction: (action: A, handler: ShortcutHandler) => void;
  useShortcutContext: (ctx: string, active?: boolean) => void;
}

export function createShortcutProvider<A extends string>(
  catalog: ShortcutCatalog<A>,
  opts: KeydownOptions<A> = {},
): ShortcutProviderKit<A> {
  const ShortcutContext = createContext<ShortcutContextValue<A> | null>(null);

  function ShortcutProvider({ children }: { children: ReactNode }): ReactElement {
    const dispatcherRef = useRef<ShortcutDispatcher<A> | null>(null);
    if (!dispatcherRef.current) dispatcherRef.current = new ShortcutDispatcher<A>();
    const dispatcher = dispatcherRef.current;

    const registerAction = useCallback(
      (action: A, handler: ShortcutHandler) => dispatcher.register(action, handler),
      [dispatcher],
    );

    const setContext = useCallback(
      (ctx: string, active: boolean) => dispatcher.setContext(ctx, active),
      [dispatcher],
    );

    const dispatchAction = useCallback(
      (action: A) => dispatcher.dispatch(action),
      [dispatcher],
    );

    // Bind the keydown logic to the HMR-stable capture listener in listener.ts.
    // The listener itself is registered at module-evaluation time (before any
    // effects), so it always fires first in the capture-phase chain.
    useEffect(() => {
      setShortcutHandler(createKeydownHandler(catalog, dispatcher, opts));
      return () => setShortcutHandler(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const value: ShortcutContextValue<A> = { registerAction, setContext, dispatchAction };

    return (
      <ShortcutContext.Provider value={value}>
        {children}
      </ShortcutContext.Provider>
    );
  }

  const NOOP_CONTEXT: ShortcutContextValue<A> = {
    registerAction: () => () => {},
    setContext: () => {},
    dispatchAction: () => false,
  };

  function useShortcuts(): ShortcutContextValue<A> {
    const ctx = useContext(ShortcutContext);
    return ctx ?? NOOP_CONTEXT;
  }

  function useShortcutAction(action: A, handler: ShortcutHandler): void {
    const { registerAction } = useShortcuts();
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    // Depends on registerAction so that when the provider remounts during HMR
    // and produces a new registerAction, children re-register their handlers in
    // the new dispatcher instead of leaving them orphaned in the old one.
    useEffect(() => {
      return registerAction(action, () => handlerRef.current());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [registerAction, action]);
  }

  function useShortcutContext(ctx: string, active: boolean = true): void {
    const { setContext } = useShortcuts();

    useEffect(() => {
      if (active) {
        setContext(ctx, true);
        return () => setContext(ctx, false);
      }
    }, [ctx, active, setContext]);
  }

  return { ShortcutProvider, useShortcuts, useShortcutAction, useShortcutContext };
}
