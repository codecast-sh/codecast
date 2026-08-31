import { describe, expect, test } from "bun:test";

describe("durable dispatch call-site guards", () => {
  test("side-panel click surfaces never pass React events into the store action", async () => {
    const source = await Bun.file(
      new URL("../../components/DashboardLayout.tsx", import.meta.url),
    ).text();

    expect(source).not.toContain("onCollapse={s.toggleSidePanel}");
    expect(source).not.toContain("onClick={s.toggleSidePanel}");
  });

  test("context session creation never bypasses the durable action outbox", async () => {
    const source = await Bun.file(
      new URL("../../components/ContextChatInput.tsx", import.meta.url),
    ).text();

    expect(source).not.toContain('_dispatch("createSession"');
    expect(source).not.toContain('_dispatch("linkConversation"');
    expect(source).toContain("beginOptimisticSession");
    expect(source).toContain("awaitConvexId");
    expect(source).toContain("linked_object");
    expect(source).toContain("sendMessage(convexId, fullMessage, undefined, clientId)");
  });

  test("standalone palette wires dispatch unconditionally", async () => {
    const source = await Bun.file(
      new URL("../../app/palette/page.tsx", import.meta.url),
    ).text();

    expect(source).toContain("useEnsureDispatch()");
    expect(source).toContain("return <ReadyPaletteRoot />");
  });

  test("anonymous shared conversations bypass a principal hydration that can never occur", async () => {
    const layout = await Bun.file(
      new URL("../../components/DashboardLayout.tsx", import.meta.url),
    ).text();
    const shell = await Bun.file(
      new URL("../../src/layouts/DashboardShell.tsx", import.meta.url),
    ).text();

    expect(shell).toContain("<DashboardLayout allowUnhydratedGuest={guestOk}>");
    expect(layout).toContain(
      "props.allowUnhydratedGuest &&",
    );
    expect(layout).toContain(
      "if (!hydrated && !isSettledGuest) return <AppLoader />;",
    );
  });

  test("in-place agent switch is the default; forks stay an explicit opt-in", async () => {
    const source = await Bun.file(
      new URL("../../components/ConversationView.tsx", import.meta.url),
    ).text();

    expect(source).toContain('convCommand(id, "switchSessionAgent"');
    expect(source).toContain("Fork as");
    expect(source).toContain("target_agent_type: t,");
    expect(source).toContain("session_id: forkSessionId,");
    expect(source).toContain("_forkTargetAgentType: t");
    expect(source).toContain("trackSessionCreate(forkSessionId, ready)");
  });

  test("result-dependent creates use durable receipts and persist their post-create intent", async () => {
    const store = await Bun.file(
      new URL("../inboxStore.ts", import.meta.url),
    ).text();
    for (const action of [
      "createDoc",
      "createPlan",
      "createProject",
      "createBucket",
    ]) {
      expect(store).toContain(`${action}: receiptAsyncAction(`);
    }
    // Fire-and-forget writes ride plain action(): optimistic paint, park-and-
    // drain delivery, server-side dedup (client id for sends, LWW for the
    // bucket patches). They are not receipt-backed.
    for (const action of ["updateBucket", "assignSessionToBucket", "sendMessage"]) {
      expect(store).toContain(`${action}: action(`);
    }

    const palette = await Bun.file(
      new URL("../../components/CommandPalette.tsx", import.meta.url),
    ).text();
    const chips = await Bun.file(
      new URL("../../components/LabelChipsRow.tsx", import.meta.url),
    ).text();
    const modal = await Bun.file(
      new URL("../../components/CreateDocModal.tsx", import.meta.url),
    ).text();
    const docsPage = await Bun.file(
      new URL("../../app/docs/page.tsx", import.meta.url),
    ).text();
    // Sidebar left this list on 2026-08-15: the section-header "+" buttons were
    // removed on request, so the rail no longer creates docs at all. If a create
    // ever returns there, it must rejoin this guard.
    const sidebar = await Bun.file(
      new URL("../../components/Sidebar.tsx", import.meta.url),
    ).text();
    expect(sidebar).not.toContain("createDoc(");
    // Inline label management still needs the canonical id to keep a fresh
    // zero-count chip visible. Session assignment callers, however, persist the
    // dependent filing intent in the create receipt instead of chaining it from
    // that ephemeral result.
    expect(chips).toContain("r.bucketId");
    expect(palette).toContain('kind: "assignBucket"');
    expect(palette).toContain("conversationIds");
    expect(palette).not.toContain("store.assignSessionToBucket(convId, r._id)");
    for (const source of [modal, docsPage]) {
      expect(source).toContain('{ version: 1, kind: "navigate" }');
    }
    expect(modal).not.toContain("router.push(`/docs/");
    expect(modal).not.toContain("router.push(`/plans/");
  });
});
