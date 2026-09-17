import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { mockInboxStore } from "./mockInboxStore";
import type { InboxSession } from "../../store/inboxStore";

// The card reads the machine roster (useRosterDevice) for the worktree chip's
// host name, and under renderToStaticMarkup zustand answers from its initial
// state — so the roster has to come through the harness override, registered
// BEFORE the panel module is imported (mock.module ordering).
const readState = mockInboxStore(() => ({
  machineRoster: [
    { device_id: "cloud-linux", is_remote: true, platform: "linux", online: false, last_seen: 1, label: "Cloud Linux" },
  ],
  machineRosterLive: true,
}), {
  // useTrackedStore is replaced too, for two reasons. It subscribes through
  // useSyncExternalStore with no server snapshot, which renderToStaticMarkup
  // treats as fatal; and it reads the store module's own binding, so the
  // overrides above would never reach the card. A static render never
  // re-renders, so handing back the state once is the whole job.
  useTrackedStore: () => readState(),
});

const { SessionCard } = await import("../GlobalSessionPanel");

// Never connects: SessionCard only registers mutation callbacks, and static
// rendering fires no effects and opens no sockets.
const client = new ConvexReactClient("https://example.convex.cloud");

const worktreePath = "/home/ubuntu/work/codecast/.codecast/worktrees/cloud-d03aaa";
const base: InboxSession = {
  _id: "c1",
  session_id: "s1",
  agent_type: "claude_code",
  message_count: 3,
  updated_at: Date.now(),
  is_idle: true,
  has_pending: false,
  project_path: worktreePath,
  git_root: worktreePath,
};

function render(overrides: Partial<InboxSession>, subRow?: "trigger") {
  return renderToStaticMarkup(
    <ConvexProvider client={client}>
      <SessionCard
        session={{ ...base, ...overrides }}
        isActive={false}
        globalIndex={0}
        onSelect={() => {}}
        sessionLabel={null}
        isFavorite={false}
        subRow={subRow}
      />
    </ConvexProvider>,
  );
}

// The full card carries the favorite control (aria-label "Favorite" when not
// favorited); the compact sub-row carries the ↳ glyph (aria-label "Subagent")
// and no favorite control. Those two literals tell the branches apart.
const SUBAGENT = 'aria-label="Subagent"';
const FAVORITE = 'aria-label="Favorite"';

describe("SessionCard: worktree and cloud sessions are first-class cards", () => {
  test("a placed cloud worktree row is a full card with the host + worktree chip", () => {
    const html = render({ worktree_name: "cloud-d03aaa", worktree_branch: "codecast/cloud-d03aaa", owner_device_id: "cloud-linux" });
    expect(html).not.toContain(SUBAGENT);
    expect(html).toContain(FAVORITE);
    expect(html).toContain("Runs on Cloud Linux");
    expect(html).toContain("Worktree cloud-d03aaa (codecast/cloud-d03aaa)");
  });

  test("a local --isolated row is a full card with the worktree chip and no host", () => {
    const html = render({ worktree_name: "session-abc1234" });
    expect(html).not.toContain(SUBAGENT);
    expect(html).toContain(FAVORITE);
    expect(html).toContain("Worktree session-abc1234");
    expect(html).not.toContain("Runs on");
  });

  test("a parked cloud row (placement pending) is a full card that says so", () => {
    const html = render({ cloud_placement: "pending", owner_device_id: "cloud-linux" });
    expect(html).not.toContain(SUBAGENT);
    expect(html).toContain(FAVORITE);
    expect(html).toContain("Preparing the cloud host");
    expect(html).toContain("Runs on Cloud Linux");
  });

  test("a plain row is a full card", () => {
    const html = render({});
    expect(html).not.toContain(SUBAGENT);
    expect(html).toContain(FAVORITE);
    expect(html).not.toContain("Worktree ");
  });

  test("a real Task subagent whose cwd is a worktree stays compact and keeps the chip", () => {
    const html = render({ is_subagent: true, parent_conversation_id: "p", worktree_name: "cloud-d03aaa" });
    expect(html).toContain(SUBAGENT);
    expect(html).not.toContain(FAVORITE);
    expect(html).toContain("Worktree cloud-d03aaa");
  });

  test("a parent-linked row without the is_subagent flag still nests", () => {
    const html = render({ parent_conversation_id: "p" });
    expect(html).toContain(SUBAGENT);
    expect(html).not.toContain(FAVORITE);
  });

  test("an agent-team teammate stays compact", () => {
    const html = render({ spawned_by_conversation_id: "lead", agent_team_name: "t", agent_name: "researcher" });
    expect(html).toContain(SUBAGENT);
    expect(html).not.toContain(FAVORITE);
  });

  test("the team lead is a full card", () => {
    const html = render({ agent_team_name: "t", agent_name: "team-lead" });
    expect(html).not.toContain(SUBAGENT);
    expect(html).toContain(FAVORITE);
  });

  test("a trigger-home sub row keeps the amber trigger glyph", () => {
    const html = render({}, "trigger");
    expect(html).toContain('aria-label="Trigger session"');
    expect(html).not.toContain(SUBAGENT);
    expect(html).not.toContain(FAVORITE);
  });

  test("a cast-spawn worker in a worktree is a full card (spawned rows never nest)", () => {
    // nestParentIdOf's agent_team_name gate: spawned_by alone is a click-through
    // pointer, not a parent, so the worker renders as its own card with its
    // location chip.
    const html = render({ spawned_by_conversation_id: "lead", worktree_name: "cloud-d03aaa" });
    expect(html).not.toContain(SUBAGENT);
    expect(html).toContain(FAVORITE);
    expect(html).toContain("Worktree cloud-d03aaa");
  });
});
