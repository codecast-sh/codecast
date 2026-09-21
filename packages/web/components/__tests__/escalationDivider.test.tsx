import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { formatSessionEscalation } from "@codecast/shared/contracts";

// The session pill asks Convex for the row it names; only the transport is
// faked, the pill and the divider are real.
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
  useConvex: () => ({ query: async () => null, mutation: async () => null }),
}));
const { classifyUserMessage, FOLD_KEPT_USER_KINDS, isStickyWorthy } = await import("../conversation/classify");
const { EscalationDivider } = await import("../conversation/blocks/systemBlocks");

// A session moving between its role and the person (org-roles-run-work.md R1,
// revised) renders as an inline divider in both threads: the role's face, the
// move, the whole line as markdown, the time. Never a bubble, never a sticky
// human prompt.
const wire = formatSessionEscalation({
  move: "handed",
  by: "role",
  role: { short_id: "or-8", handle: "calling", name: "Calling", avatar: "fox" },
  session: { short_id: "jx7abcd", title: "Market growth mandate" },
  to: "Ashot",
  at: 1_790_000_000_000,
  line: "how a market is **filled** is yours to call\n\n- 40 seats now\n- or 80 after the pilot",
});
const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe("escalation divider", () => {
  test("classifies as its own kind, kept when folded, never sticky", () => {
    const kind = classifyUserMessage({ _id: "m1", role: "user", content: wire, timestamp: 1 });
    expect(kind.kind).toBe("session_escalation");
    if (kind.kind !== "session_escalation") throw new Error("kind");
    expect(kind.escalation.role.handle).toBe("calling");
    expect(FOLD_KEPT_USER_KINDS.has(kind.kind)).toBe(false);
    expect(isStickyWorthy(kind)).toBe(false);
  });

  test("in the child's thread: the face, 'this session', the whole line as markdown, no pill", () => {
    const kind = classifyUserMessage({ _id: "m1", role: "user", content: wire, timestamp: 1 });
    if (kind.kind !== "session_escalation") throw new Error("kind");
    const html = render(<EscalationDivider escalation={kind.escalation} conversationShortId="jx7abcd" timestamp={1_790_000_000_000} />);
    expect(html).toContain('data-switch-divider="escalation-handed"');
    expect(html).toContain("@calling handed this session to Ashot");
    expect(html).toContain("<strong>filled</strong>");
    expect(html).toContain("<li>40 seats now</li>");
    expect(html).toContain("or 80 after the pilot");
    // The role's face is drawn; the session pill is not (it is this thread).
    expect(html).toMatch(/<img[^>]*alt="Calling"/);
    expect(html).not.toContain(">jx7abcd<");
  });

  test("in the role's thread: the session is named by its pill; a hand back has no body", () => {
    const kind = classifyUserMessage({ _id: "m1", role: "user", content: wire, timestamp: 1 });
    if (kind.kind !== "session_escalation") throw new Error("kind");
    const html = render(<EscalationDivider escalation={kind.escalation} conversationShortId="jx7rolee" timestamp={1_790_000_000_000} />);
    expect(html).toContain("@calling handed jx7abcd to Ashot");
    expect(html).toContain("jx7abcd");
    const back = classifyUserMessage({ _id: "m2", role: "user", content: formatSessionEscalation({ move: "back", by: "person", role: { short_id: "or-8", handle: "calling", name: "Calling" }, session: { short_id: "jx7abcd" }, to: "Ashot", at: 1, line: "" }), timestamp: 2 });
    if (back.kind !== "session_escalation") throw new Error("kind");
    const backHtml = render(<EscalationDivider escalation={back.escalation} conversationShortId="jx7abcd" timestamp={2} />);
    expect(backHtml).toContain("this session is back with @calling");
    expect(backHtml).not.toContain("data-switch-divider-body");
  });
});
