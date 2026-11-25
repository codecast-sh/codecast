// Requests a language server sends to the editor. @codemirror/lsp-client
// answers every one of them "method not found", which costs real features:
// a server that cannot create a progress token never reports indexing, a code
// action that runs a command never gets its edit applied, and rust-analyzer
// waits on workspace/configuration. This sits between the client and the
// transport and answers the ones codecast can, passing everything else on.

import type { Transport } from "@codemirror/lsp-client";

export type ServerRequestHandler = (params: any) => unknown | Promise<unknown>;

export interface RoutedTransport extends Transport {
  /** Replace the handlers (the pool installs them once the workspace exists). */
  handle(handlers: Record<string, ServerRequestHandler>): void;
}

/** The handlers every client gets regardless of workspace. */
export function baseServerHandlers(rootUri: () => string | undefined): Record<string, ServerRequestHandler> {
  return {
    // Progress is reported through $/progress, handled as a notification.
    "window/workDoneProgress/create": () => null,
    // No per-server settings yet: an empty answer per item means "defaults".
    "workspace/configuration": (params: { items?: unknown[] }) => (params?.items ?? []).map(() => null),
    "client/registerCapability": () => null,
    "client/unregisterCapability": () => null,
    "workspace/workspaceFolders": () => {
      const uri = rootUri();
      return uri ? [{ uri, name: uri.slice(uri.lastIndexOf("/") + 1) }] : null;
    },
    // The editor has nowhere to put a server's question yet; no choice made.
    "window/showMessageRequest": () => null,
    "window/showDocument": () => ({ success: false }),
  };
}

/** Wrap a transport so server requests named in the handlers are answered here. */
export function routeServerRequests(inner: Transport, handlers: Record<string, ServerRequestHandler> = {}): RoutedTransport {
  let table = handlers;
  const subscribers = new Map<(m: string) => void, (m: string) => void>();
  const reply = (id: unknown, body: { result?: unknown; error?: unknown }) => {
    try {
      inner.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
    } catch {
      // Gone: the daemon answers the server for a detached editor.
    }
  };
  return {
    send: (m) => inner.send(m),
    subscribe(handler) {
      const wrapped = (message: string) => {
        // Responses and notifications have no "method" with an "id" pair; only
        // a request has both. Most traffic is responses, so look cheaply first.
        if (message.includes('"method"') && message.includes('"id"')) {
          let msg: { id?: unknown; method?: string; params?: unknown };
          try {
            msg = JSON.parse(message);
          } catch {
            return handler(message);
          }
          const fn = msg.method !== undefined && msg.id !== undefined ? table[msg.method] : undefined;
          if (fn) {
            Promise.resolve()
              .then(() => fn(msg.params))
              .then(
                (result) => reply(msg.id, { result: result ?? null }),
                (err) => reply(msg.id, { error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }),
              );
            return;
          }
        }
        handler(message);
      };
      subscribers.set(handler, wrapped);
      inner.subscribe(wrapped);
    },
    unsubscribe(handler) {
      const wrapped = subscribers.get(handler);
      if (!wrapped) return;
      subscribers.delete(handler);
      inner.unsubscribe(wrapped);
    },
    handle(next) {
      table = { ...table, ...next };
    },
  };
}
