import { createContext } from "react";
import type { ChatWakePrompt } from "../components/sessionMessage";
import type { BrowserRowState } from "../components/castCommand";

// toolCallId → the page URL and driven tab a `cast browser` row was on,
// carried forward from earlier rows when the row's own output doesn't restate
// them (most action verbs don't — see buildBrowserRowMap). CastCommandBlock
// falls back to this for its "open tab" link. Provided by the message feed
// with a content-stable identity so an unrelated message sync doesn't
// re-render every cast row.
export const CastBrowserRowContext = createContext<Record<string, BrowserRowState>>({});

// placeholder message id → the team-chat wake that asked for it. A `cast chat
// reply` names only the placeholder, so the reply card reads the channel and
// thread off the wake in the same transcript — no lookup, and it still works
// after the chat thread is deleted. Keyed by placeholder id, so identity is
// stable across syncs that added no wake.
export const ChatWakeContext = createContext<Record<string, ChatWakePrompt>>({});
