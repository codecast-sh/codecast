import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SignInCta } from "../GlobalSessionPanel";

// Never connects: SignInCta only registers a mutation callback, and static
// rendering fires no effects and opens no sockets.
const client = new ConvexReactClient("https://example.convex.cloud");

type Device = Parameters<typeof SignInCta>[0]["device"];

function render(device: Device) {
  return renderToStaticMarkup(
    <ConvexProvider client={client}>
      <SignInCta device={device} authSessionIds={["s1", "s2"]} disabled={false} />
    </ConvexProvider>,
  );
}

const now = Date.now();

describe("SignInCta account labeling", () => {
  test("a stale confirmed flow does not pin the old account after a switch", () => {
    // The reported state: the machine has switched to claude6, but a
    // cc_login_flow row from an incident days ago still names claude4.
    // The button launches a sign-in for the CURRENT login, so it must be
    // labeled with the live active_email, not the leftover flow email.
    const html = render({
      device_id: "d1",
      active_email: "claude6@example.com",
      login_flow: {
        status: "confirmed",
        email: "claude4@example.com",
        started_at: now - 3 * 86_400_000,
        finished_at: now - 3 * 86_400_000 + 20_000,
      },
    });
    expect(html).toContain("Sign in as claude6@example.com");
    expect(html).not.toContain("claude4@example.com");
  });

  test("the pending spinner names the account the flow belongs to", () => {
    const html = render({
      device_id: "d1",
      label: "m1.local",
      active_email: "claude6@example.com",
      login_flow: {
        status: "pending",
        email: "claude6@example.com",
        started_at: now - 5_000,
      },
    });
    expect(html).toContain("Finish signing in as claude6@example.com");
    expect(html).toContain("m1.local");
  });

  test("the pending spinner offers a relaunch for a tab that never opened", () => {
    const html = render({
      device_id: "d1",
      label: "m1.local",
      active_email: "claude6@example.com",
      login_flow: {
        status: "pending",
        email: "claude6@example.com",
        started_at: now - 5_000,
      },
    });
    expect(html).toContain("Relaunch the sign-in");
  });

  test("with no live login the button falls back to the flow email", () => {
    const html = render({
      device_id: "d1",
      login_flow: {
        status: "rejected",
        email: "only@example.com",
        started_at: now - 86_400_000,
        finished_at: now - 86_400_000 + 20_000,
      },
    });
    expect(html).toContain("Sign in as only@example.com");
  });

  test("a recent rejection shows the retry button with the reason", () => {
    const html = render({
      device_id: "d1",
      active_email: "claude6@example.com",
      login_flow: {
        status: "rejected",
        email: "claude6@example.com",
        reason: "browser closed",
        started_at: now - 120_000,
        finished_at: now - 60_000,
      },
    });
    expect(html).toContain("browser closed");
    expect(html).toContain("Try signing in as claude6@example.com again");
  });
});
