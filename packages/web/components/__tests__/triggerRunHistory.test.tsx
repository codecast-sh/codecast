import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TriggerRunList, TriggerRunRail, type TriggerRun } from "../TriggerRunHistory";

// The list's navigation shim (next/navigation → react-router) needs a router
// in scope; the rail has none, so both render through the same wrapper.
const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

// A firing the `--precheck` gate refused spawns no agent, so it has no
// conversation. It still has to APPEAR in the run history — "the trigger fired
// and deliberately did nothing" is exactly what a user reading this list needs
// to know — but it must never render as something to click, because there is
// nothing behind it.

const NOW = 1_700_000_000_000;

const spawned: TriggerRun = {
  _id: "conv1",
  run_key: "conv1",
  kind: "spawn",
  title: "Nightly audit",
  created_at: NOW - 60_000,
  trigger_message_id: "msg1",
};

const skipped: TriggerRun = {
  _id: "skip1",
  run_key: "skip1",
  kind: "skipped_precheck",
  title: "precheck exited 1",
  created_at: NOW - 30_000,
  precheck_command: "git fetch && git diff --quiet origin/main",
};

describe("precheck skips in the run history", () => {
  test("a skipped firing renders as a labelled, unclickable row", () => {
    const html = render(<TriggerRunList runs={[skipped, spawned]} now={NOW} />);
    expect(html).toContain("precheck exited 1");
    expect(html).toContain(">skipped<");
    expect(html).toContain('data-testid="trigger-run-skipped"');
    // Only the real run is a button; the skip is a plain row.
    expect(html.match(/<button/g) ?? []).toHaveLength(1);
    expect(html).toContain("Nightly audit");
  });

  test("run numbering counts the skip, so the history reads as one timeline", () => {
    const html = render(<TriggerRunList runs={[skipped, spawned]} now={NOW} />);
    expect(html).toContain("#2");
    expect(html).toContain("#1");
  });

  test("the header rail counts sessions only — a skip has no node to open", () => {
    const html = render(
      <TriggerRunRail runs={[skipped, spawned]} now={NOW} conversationId="conv1" />,
    );
    expect(html).toContain("1 run");
    expect(html).not.toContain("2 runs");
    expect(html).not.toContain("precheck exited 1");
  });

  test("a history of nothing but skips still renders, and the rail stays empty", () => {
    expect(render(<TriggerRunList runs={[skipped]} now={NOW} />)).toContain(
      "precheck exited 1",
    );
    expect(
      render(<TriggerRunRail runs={[skipped]} now={NOW} conversationId="conv1" />),
    ).toBe("");
  });
});
