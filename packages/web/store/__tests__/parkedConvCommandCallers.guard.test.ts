import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return await Bun.file(new URL(path, import.meta.url)).text();
}

describe("parked convCommand caller policy", () => {
  test("restart surfaces keep a durably parked request in their recovery state", async () => {
    const [restartHook, commands, queuePage, globalPanel] = await Promise.all([
      source("../../hooks/useSessionRestart.ts"),
      source("../../lib/sessionCommands.ts"),
      source("../../app/inbox/QueuePageClient.tsx"),
      source("../../components/GlobalSessionPanel.tsx"),
    ]);

    expect(restartHook).toContain("if (isParkedDispatchError(err)) return;");
    // A parked restart keeps its row in flight; any other refusal settles the
    // row failed, which is what the hook's phase reads.
    expect(commands).toContain("if (!isParkedDispatchError(error)) recordSessionCommandDispatchError(requestId, error);");
    expect(restartHook).toContain("restartPhaseOf(gesture, now)");
    expect(queuePage.match(/isParkedDispatchError/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(queuePage).toContain('setResumeState("failed")');
    expect(globalPanel.match(/isParkedDispatchError/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(globalPanel).toContain('setResumeState("failed")');
  });

  test("project switch and kill callers suppress only parked:true failures", async () => {
    const [conversationView, sessionsPage, globalPanel] = await Promise.all([
      source("../../components/conversation/sessionControls.tsx"),
      source("../../app/sessions/page.tsx"),
      source("../../components/GlobalSessionPanel.tsx"),
    ]);

    // Only a parked failure skips putting the old path back.
    expect(conversationView).toMatch(
      /if \(isParkedDispatchError\(err\)\) return;\n(?:\s*\/\/[^\n]*\n)*\s*if \(prevPath\)/,
    );
    // The sessions page kills through the shared gesture (the store's kill
    // action and its undo), never a convCommand of its own.
    expect(sessionsPage).toContain("killWithNotice(s.conversation_id)");
    expect(sessionsPage).not.toContain('"killSession"');
    expect(globalPanel).toContain(
      'if (isParkedDispatchError(err)) return;',
    );
    expect(globalPanel).toContain("toast.error(`Kill failed:");
  });

  test("fire-and-forget session controls observe their asyncAction rejection", async () => {
    // The conversation view owns rewind, a hook owns permission mode, and the
    // shared composer controls own Escape (the view and Threads cards both use it).
    const conversationView = [
      await source("../../components/ConversationView.tsx"),
      await source("../../hooks/usePermissionModeSwitch.ts"),
      await source("../../hooks/useSessionComposerControls.ts"),
    ].join("\n");

    for (const command of [
      "setPermissionMode",
      "rewindSession",
    ]) {
      expect(conversationView).toMatch(
        new RegExp(`convCommand\\([^\\n]+, "${command}"[^\\n]*\\)\\.catch\\(\\(err\\)`),
      );
    }
    // Escape rides the store's sendEscape (it stamps the press time), which is
    // the same convCommand, and the composer observes its rejection.
    expect(conversationView).toMatch(/sendEscape\(conversationId\)\.catch\(\(err\)/);
    expect(await source("../inboxStore.ts")).toMatch(/sendEscape: \(convId: string\) => get\(\)\.convCommand\(convId, "sendEscapeToSession"/);
    expect(conversationView).toContain(
      "Escape queued — it will send when the connection recovers",
    );
    expect(conversationView).toContain("if (isParkedDispatchError(err)) return;");
    expect(conversationView).toContain('toast.error(err instanceof Error ? err.message : "Failed to send Escape")');
  });
});
