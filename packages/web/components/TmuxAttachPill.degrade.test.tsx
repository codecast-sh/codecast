import { test, expect, describe, mock } from "bun:test";

/**
 * The reported crash, end to end: on 2026-08-11 the web bundle shipped ahead of
 * the convex deploy, so devices.getConversationMachine answered "Could not find
 * public function", the pill's useQuery re-threw during render, and the whole
 * conversation header went to its ErrorBoundary.
 *
 * The pill's job is the pane name, and it already holds that as a prop. So the
 * machine lookup failing may cost the machine's NAME and nothing else.
 */

const missingFunction = new Error(
  "[Request ID: e460f7bdf61343dc] Server Error\nCould not find public function for 'devices:getConversationMachine'.",
);

const FOREIGN_MACHINE = {
  device_id: "965fa002dd353cd5",
  label: "macOS - Mac-mini",
  platform: "darwin",
  is_remote: false,
  is_mine: false,
  ssh_host: null,
};

// What the machine lookup answers. Swapped per test so the same render path
// covers both the failure and the ordinary resolved case.
let lookup: () => { data?: unknown; error?: Error } = () => ({
  data: undefined,
  error: missingFunction,
});
const noThrow = await import("../hooks/useQueryNoThrow");
mock.module("../hooks/useQueryNoThrow", () => ({
  ...noThrow,
  useQueryNoThrow: () => lookup(),
}));

// The pill only needs to know whether the split is open. Keep every other
// export real: mock.module replaces the module process-wide, and a partial stub
// breaks any later test file that imports a name this one left out.
const terminal = await import("./terminal/ConversationTerminal");
mock.module("./terminal/ConversationTerminal", () => ({
  ...terminal,
  isConversationTerminalOpen: () => false,
  toggleConversationTerminal: () => {},
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { TmuxAttachPill } = await import("./TmuxAttachPill");

const render = () =>
  renderToStaticMarkup(
    <TmuxAttachPill tmuxSession="cc-resume-7ea05201" isLive conversationKey="jx7fata" />,
  );

describe("TmuxAttachPill under a backend that lacks the query", () => {
  // Rendering at all IS the assertion — this threw before the fix.
  test("still renders the pane pill", () => {
    lookup = () => ({ data: undefined, error: missingFunction });
    const html = render();
    expect(html).toContain("tmux");
  });

  // Unknown machine is a state the pill already had a truthful answer for: the
  // plain local command, exactly what it offered before the lookup existed.
  // The command itself sits in the tooltip, which Radix renders only on hover,
  // so the observable signal here is that copy stays live. attachCommand's own
  // fallback is covered directly in tmuxAttachPill.test.ts.
  test("still offers a command to copy", () => {
    lookup = () => ({ data: undefined, error: missingFunction });
    expect(render()).toContain('aria-disabled="false"');
  });

  // The failure must not be mistaken for "this pane is on someone else's box",
  // which is the one case where the pill withholds a command entirely and
  // labels itself with the machine's name instead of "tmux".
  test("does not degrade into the state for a pane on another machine", () => {
    lookup = () => ({ data: undefined, error: missingFunction });
    const html = render();
    expect(html).toContain(">tmux<");
    expect(html).not.toContain('aria-disabled="true"');
  });

  // The other half of the swap: when the lookup DOES resolve, the wrapper must
  // pass the machine through untouched. Same render path, so this is what
  // proves the change is invisible on the ordinary path: a teammate's pane is
  // named after its machine and offers no copy button at all.
  test("a resolved machine still names it and withholds the command", () => {
    lookup = () => ({ data: FOREIGN_MACHINE, error: undefined });
    const html = render();
    expect(html).toContain("Mac-mini");
    expect(html).not.toContain('aria-label="Copy tmux attach command"');
  });
});
