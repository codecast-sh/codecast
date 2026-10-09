// The shared queue as drawn for a session that was away: 25 rows of trigger
// runs and session messages read as a few lines, none of them the wire tags.
// Run: bun test components/conversation/SharedQueue.mount.test.tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ConvexProvider } from "convex/react";
import { formatScheduledTask, formatSessionMessage } from "@codecast/shared/contracts";
import { heroConvexStub } from "../../app/(marketing)/heroFly/convexStub";
import { EntityFixtureContext } from "../../lib/entityDisplay";
import { useInboxStore } from "../../store/inboxStore";
import { SharedQueue } from "./SharedQueue";

const CONV = "jx73kh08h7rrrejtpvgd43sq2n8fb35j";
let n = 0;
const row = (content: string, from = "Ashot Petrosian") => ({ message_id: `m${++n}`, created_at: Date.now() - 86_400_000 * 3, status: "pending", content, from_name: from, from_user_id: `u_${from}` });
const wake = (session: string) => row(formatScheduledTask({ title: "A session under you needs input", trigger: "tr-1167", waiting: { short_id: session, title: "Worker", why: "blocked", since: 1, state: `Blocked on a key (${session})` }, body: "A session that reports to you is waiting." }));
const fromSession = (from: string, body: string) => row(formatSessionMessage(from, body, { name: "Ashot Petrosian" }));

function render(inflight: any[]) {
  useInboxStore.setState({ pendingMessageStatus: { [CONV]: { _id: CONV, conversation_id: CONV, inflight } } } as any);
  return renderToStaticMarkup(
    <ConvexProvider client={heroConvexStub}>
      <MemoryRouter>
        <EntityFixtureContext.Provider value={{}}>
          <SharedQueue conversationId={CONV} canSteerQueue />
        </EntityFixtureContext.Provider>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("SharedQueue", () => {
  test("a backlog reads as a few lines: runs folded with a count, the rest behind one control, no wire tags", () => {
    const inflight = [
      fromSession("jx7c12d", "Delivery check from the Chief of Staff"),
      ...Array.from({ length: 8 }, (_, i) => wake(`jx7w00${i}`)),
      fromSession("jx79zjy", "Second check"),
      row("You are the **Agent Quality lead** (@agent-quality) in Union.\n\nMore.", "Jason Benn"),
      ...Array.from({ length: 6 }, (_, i) => wake(`jx7w01${i}`)),
      fromSession("jx74mma", "one"), fromSession("jx74mma", "two"),
      wake("jx7w020"),
      fromSession("jx78mpg", "three"), fromSession("jx78mpg", "four"), fromSession("jx7312g", "five"),
      row(formatScheduledTask({ title: "Morning agenda", body: "Set the day." }), "Jason Benn"),
      fromSession("jx79zjy", "last"),
    ];
    expect(inflight).toHaveLength(25);
    const html = render(inflight);
    expect(html).not.toContain("&lt;scheduled-task");
    expect(html).not.toContain("&lt;session-message");
    expect(html).toContain(">25<");
    // Five lines at rest: session, the run of 8, session, the brief, the run of 6.
    expect(html.match(/<li /g)).toHaveLength(5);
    expect(html).toContain('data-sv-queue-run="8"');
    expect(html).toContain("×8");
    expect(html).toContain('data-sv-queue-run="6"');
    expect(html).toContain("A session under you needs input");
    expect(html).toContain("Delivery check from the Chief of Staff");
    expect(html).toContain("role brief");
    expect(html).toContain("You are the Agent Quality lead (@agent-quality) in Union.");
    // 25 rows, 17 of them drawn in those five lines.
    expect(html).toContain("8 more waiting");
  });

  test("a single trigger run names the session it fired for and what that session pinned", () => {
    const html = render([wake("jx7w001"), row("fix the header", "Ann")]);
    expect(html).toContain("A session under you needs input");
    expect(html).toContain("Blocked on a key (jx7w001)");
    expect(html).toContain("fix the header");
    expect(html).not.toContain("data-sv-queue-run");
    expect(html).not.toContain("data-sv-queue-more");
  });
});
