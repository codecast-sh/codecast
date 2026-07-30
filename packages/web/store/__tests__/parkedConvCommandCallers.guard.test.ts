import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return await Bun.file(new URL(path, import.meta.url)).text();
}

describe("parked convCommand caller policy", () => {
  test("restart surfaces keep a durably parked request in their recovery state", async () => {
    const [restartHook, queuePage, globalPanel] = await Promise.all([
      source("../../hooks/useSessionRestart.ts"),
      source("../../app/inbox/QueuePageClient.tsx"),
      source("../../components/GlobalSessionPanel.tsx"),
    ]);

    expect(restartHook).toContain("if (isParkedDispatchError(err)) return;");
    expect(restartHook).toContain('setPhase("failed")');
    expect(queuePage.match(/isParkedDispatchError/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(queuePage).toContain('setResumeState("failed")');
    expect(globalPanel.match(/isParkedDispatchError/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(globalPanel).toContain('setResumeState("failed")');
  });

  test("project switch and kill callers suppress only parked:true failures", async () => {
    const [conversationView, sessionsPage, globalPanel] = await Promise.all([
      source("../../components/ConversationView.tsx"),
      source("../../app/sessions/page.tsx"),
      source("../../components/GlobalSessionPanel.tsx"),
    ]);

    expect(conversationView).toContain(
      'if (isParkedDispatchError(err)) return;\n      if (prevPath)',
    );
    expect(sessionsPage).toContain(
      'if (isParkedDispatchError(err)) return;',
    );
    expect(sessionsPage).toContain("toast.error(`Kill failed:");
    expect(globalPanel).toContain(
      'if (isParkedDispatchError(err)) return;',
    );
    expect(globalPanel).toContain("toast.error(`Kill failed:");
  });

  test("fire-and-forget session controls observe their asyncAction rejection", async () => {
    const conversationView = await source("../../components/ConversationView.tsx");

    for (const command of [
      "sendKeysToSession",
      "rewindSession",
    ]) {
      expect(conversationView).toMatch(
        new RegExp(`convCommand\\([^\\n]+, "${command}"[^\\n]*\\)\\.catch\\(\\(err\\)`),
      );
    }
    // Escape reports "sent" only after an acknowledgement. A parked command is
    // still durable, but must be described honestly as queued.
    expect(conversationView).toMatch(
      /convCommand\([^\n]+, "sendEscapeToSession"\)\.then\(/,
    );
    expect(conversationView).toContain(
      "Escape queued — it will send when the connection recovers",
    );
    expect(conversationView).toContain("if (isParkedDispatchError(err)) return;");
    expect(conversationView).toContain('toast.error(err instanceof Error ? err.message : "Failed to send Escape")');
  });
});
