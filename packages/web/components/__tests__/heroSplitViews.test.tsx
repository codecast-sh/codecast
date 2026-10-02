import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider } from "convex/react";
import { heroConvexStub } from "../../app/(marketing)/heroFly/convexStub";
import { PermissionStack, PermissionStackView } from "../PermissionCard";
import { AgentStatusPill } from "../conversation/ConversationHeaderBar";
import { agentStatusPillSpec } from "../conversation/agentStatusPill";
import { ComposerSendButton, ComposerShell, ComposerTextarea, ComposerTextRow } from "../ComposerShell";
import { WorkingStatusLine, WorkingStatusLineView } from "../conversation/sessionChrome";

// The views the marketing hero renders with fixtures. Each is a move out of a
// product container; these tests pin that the container adds no markup of its
// own and that a view renders from plain props with no provider around it.

const row = (id: string, tool: string, preview?: string, status: "pending" | "approved" = "pending") =>
  ({ _id: id, tool_name: tool, arguments_preview: preview, status, created_at: 1, conversation_id: "c1" }) as any;
const noop = () => {};

describe("PermissionStackView", () => {
  const cases = {
    single: [row("a", "Bash", "npm test --workspace packages/api")],
    long: [row("a", "Bash", "x".repeat(120))],
    multi: [row("a", "Bash", "ls"), row("b", "Edit", "api/retry.ts"), row("c", "Bash", "pwd", "approved")],
  };
  for (const [name, list] of Object.entries(cases)) {
    for (const allowAll of [false, true]) {
      test(`the container renders exactly the view (${name}${allowAll ? ", allow all" : ""})`, () => {
        const container = renderToStaticMarkup(
          <ConvexProvider client={heroConvexStub}>
            <PermissionStack permissions={list} onAllowAll={allowAll ? noop : undefined} />
          </ConvexProvider>,
        );
        const view = renderToStaticMarkup(
          <PermissionStackView
            pending={list.filter((p: any) => p.status === "pending")}
            inflight={new Set()}
            onApprove={noop}
            onDeny={noop}
            onApproveAll={noop}
            onDenyAll={noop}
            onAllowAll={allowAll ? noop : undefined}
          />,
        );
        expect(container).toBe(view);
      });
    }
  }

  test("an in-flight row shows the ellipsis and disables its buttons", () => {
    const html = renderToStaticMarkup(
      <PermissionStackView pending={[row("hero-p1", "Bash", "npm test")]} inflight={new Set(["hero-p1"])} onApprove={noop} onDeny={noop} onApproveAll={noop} onDenyAll={noop} />,
    );
    expect(html).toContain(">...</button>");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("AgentStatusPill", () => {
  const label = (s: string | undefined, disconnected = false, live = false) => agentStatusPillSpec(s, { disconnected, live })?.label ?? null;

  test("labels", () => {
    expect(label("working")).toBe("Working");
    expect(label("thinking")).toBe("Thinking");
    expect(label("waiting")).toBe("Dormant");
    expect(label("permission_blocked")).toBe("Needs Input");
    expect(label("connected")).toBe("Connected");
    expect(label("connected", true)).toBe("Delivering");
    expect(label("working", true)).toBe("Disconnected");
    expect(label(undefined, false, true)).toBe("Working");
  });

  test("quiet statuses show nothing", () => {
    for (const s of ["idle", "done", "stopped", undefined]) expect(label(s)).toBeNull();
    expect(label("hibernated", true)).toBeNull();
    expect(renderToStaticMarkup(<AgentStatusPill agentStatus="idle" />)).toBe("");
  });
});

test("ComposerShell renders a fixture draft with no provider", () => {
  const html = renderToStaticMarkup(
    <ComposerShell expanded meta="Working">
      <ComposerTextRow send={<ComposerSendButton canSubmit />}>
        <ComposerTextarea value="retry failed webhooks" readOnly placeholder="Send a message..." />
      </ComposerTextRow>
    </ComposerShell>,
  );
  expect(html).toContain("retry failed webhooks");
  expect(html).toContain("data-cc-composer-meta");
  expect(html).toContain("rounded-2xl");
  expect(html).not.toContain("disabled=\"\"");
});

test("WorkingStatusLine renders exactly its view once it has read the clock and the row", () => {
  const now = 1_700_000_000_000;
  const spy = spyOn(Date, "now").mockReturnValue(now);
  try {
    const container = renderToStaticMarkup(<WorkingStatusLine startedAt={now - 95_000} phrase="running bun test" conversationId="hero-conv" />);
    const view = renderToStaticMarkup(<WorkingStatusLineView startedAt={now - 95_000} now={now} label="running bun test" />);
    expect(container).toBe(view);
    expect(view).toContain("1:35");
    expect(view).toContain("running bun test");
  } finally {
    spy.mockRestore();
  }
});

test("the working line says Escape stops the turn only when asked to (an owner's empty composer)", () => {
  const now = 1_790_000_000_000;
  const hinted = renderToStaticMarkup(<WorkingStatusLineView startedAt={now - 95_000} now={now} label="running" stopHint />);
  expect(hinted).toContain("data-stop-hint");
  expect(hinted).toContain(">Esc</kbd>");
  expect(renderToStaticMarkup(<WorkingStatusLineView startedAt={now - 95_000} now={now} label="running" />)).not.toContain("data-stop-hint");
});
