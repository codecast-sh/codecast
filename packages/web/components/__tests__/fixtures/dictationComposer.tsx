// The harness the dictation mount tests share (dictation.mount,
// dictationComposerKeys.mount): toasts heard, a recognizer the test speaks
// through, and the composer mounted on it. Import it right after composeDom.
import { w } from "./composeDom";
import { mock } from "bun:test";

// The lines a recording's end says once (useDictation), as the toast shows them.
export const toasts: string[] = [];
mock.module("sonner", () => {
  const noop = () => 1;
  const say = (kind: string) => (line: string) => { toasts.push(`${kind}: ${line}`); return 1; };
  return { toast: Object.assign(say("info"), { error: say("error"), info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { _resetDictationForTests, type DictationPipeEvents, type DictationHost } from "@codecast/shared/contracts/dictation";
import { useInboxStore } from "../../../store/inboxStore";
import { _resetCrossWindowForTests } from "../../../lib/dictation/crossWindow";
// Entered from the composer, the graph reaches ChatMessage through
// messageMarkdown -> EntityIdPill -> TaskCommentStream; entering from
// ChatMessage closes that cycle on a lazy read (markdownMapCycles.guard).
import "../../chat/ChatMessage";
import { offlineConvexClient } from "../../../test-helpers/offlineConvex";
import { holdTextareaTextNodes } from "../../../lib/holdTextareaTextNode";

// The app installs this at boot: a textarea's defaultValue write that repeats
// its live value is skipped. Dictated words must still show with it on.
holdTextareaTextNodes(w);
// The slash/mention picker scrolls its selected row into view.
(w.Element.prototype as any).scrollIntoView ??= () => {};

export function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).action = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

/** A recognizer the test speaks through. */
export function fakeHost() {
  const h = {
    events: null as DictationPipeEvents | null,
    refuse: null as string | null,
    closed: 0,
    finishing: false,
    endFinish: null as null | (() => void),
    host: null as unknown as DictationHost,
  };
  h.host = {
    open: (events) => {
      h.events = events;
      if (h.refuse) return Promise.reject(new Error(h.refuse));
      return Promise.resolve({
        finish: () =>
          new Promise<void>((resolve) => {
            h.finishing = true;
            h.endFinish = resolve;
          }),
        close: () => {
          h.closed++;
          // As asrPipe does: closing releases a finish still waiting.
          h.endFinish?.();
        },
      });
    },
  };
  return h;
}

export type FakeHost = ReturnType<typeof fakeHost>;

/** Each test's start: no recording anywhere, a fresh recognizer, dictation on. */
export function freshDictationHarness(): FakeHost {
  _resetDictationForTests();
  // No other window answers here; a test of one passes a wait of its own.
  _resetCrossWindowForTests(0);
  const host = fakeHost();
  w.__dictationTestHost = host.host;
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({
    sessions: {},
    conversations: {},
    pendingMessages: {},
    drafts: {},
    reviewComments: {},
    teams: [],
    currentSessionId: null,
    currentUser: { _id: "user_dictation_test", name: "Tester", dictation_enabled: true } as any,
  } as any);
  return host;
}

export const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Speak through the recognizer of the recording now open. */
export const sayTo = (host: () => FakeHost) => async (fn: (e: DictationPipeEvents) => void) => {
  await act(async () => { fn(host().events!); });
  await flush();
};

let run = 0;

export async function mountComposer(opts: { bare?: boolean; foot?: boolean; initialDraft?: string; props?: Record<string, unknown>; wrap?: (composer: ReactElement) => ReactElement } = {}) {
  const sent: string[] = [];
  const { MessageInput } = await import("../../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root: Root = createRoot(container);
  const draftKey = `chat-draft:dictation-${++run}`;
  const client = fakeConvex();
  const wrap = opts.wrap ?? ((composer: ReactElement) => composer);
  const draw = (conversationId: string) => root.render(
      <ConvexProvider client={client}>
        {wrap(<MessageInput
          bareComposer={opts.bare}
          initialDraft={opts.initialDraft}
          composerFoot={opts.foot ? <span data-foot-start /> : undefined}
          onGateSend={(content) => { sent.push(content); }}
          {...opts.props}
          conversationId={conversationId}
        />)}
      </ConvexProvider>,
  );
  const firstKey = (opts.props?.conversationId as string | undefined) ?? draftKey;
  await act(async () => { draw(firstKey); });
  /** The same composer, now for another conversation (ComposeView reuses it without a key). */
  const switchTo = async (conversationId: string) => {
    await act(async () => { draw(conversationId); });
    await flush();
  };
  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
  const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement;
  const button = (label: string) => container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  const press = async (label: string) => {
    const b = button(label);
    if (!b) throw new Error(`no ${label} button`);
    await act(async () => { b.click(); });
    await flush();
  };
  const key = async (k: string, init: Record<string, unknown> = {}) => {
    await act(async () => { textarea().dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
    await flush();
  };
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
  return { container, q, textarea, button, press, key, sent, unmount, switchTo, draftKey: firstKey };
}
