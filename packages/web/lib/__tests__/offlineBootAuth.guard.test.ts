import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authGateDecision } from "@platform/auth/web";

const WEB_ROOT = join(import.meta.dir, "..", "..");

describe("offline boot auth", () => {
  test("a stored token renders while server auth is unresolved or offline", () => {
    expect(authGateDecision({
      localAuthed: true,
      isAuthenticated: false,
      isLoading: true,
    })).toBe("children");
    expect(authGateDecision({
      localAuthed: true,
      isAuthenticated: false,
      isLoading: false,
    })).toBe("children");
  });

  test("boot-critical conversation surfaces use the local-first auth gate", () => {
    for (const relativePath of [
      "components/DashboardLayout.tsx",
      "app/conversation/[id]/ConversationPageClient.tsx",
    ]) {
      const source = readFileSync(join(WEB_ROOT, relativePath), "utf8");
      expect(source).toContain("useAuthGate(useLocalAuth)");
    }
  });

  test("the visible conversation cache hydrates before the app is released", () => {
    const source = readFileSync(join(WEB_ROOT, "store/inboxStore.ts"), "utf8");
    const hydrate = source.indexOf("await ensureHydrated(focusId)");
    const release = source.indexOf(
      "useInboxStore.setState({ clientStateInitialized: true });",
      hydrate,
    );

    expect(hydrate).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(hydrate);
    expect(source).toContain(
      "const restoreId = requestedId ?? ownId ?? st.clientState?.current_conversation_id",
    );
  });

  test("interaction-only conversation tools stay outside the blocking route graph", () => {
    const source = readFileSync(join(WEB_ROOT, "components/ConversationView.tsx"), "utf8");

    for (const component of [
      "CommentDock",
      "ComposeEditor",
      "ConversationTerminalSplit",
      "SessionHuddleButton",
    ]) {
      expect(source).toContain(`const ${component} = lazy(() => import(`);
    }
  });

  test("a warm cache can paint before either boot indicator appears", () => {
    const html = readFileSync(join(WEB_ROOT, "index.html"), "utf8");
    const layout = readFileSync(join(WEB_ROOT, "components/DashboardLayout.tsx"), "utf8");

    expect(html).toContain("animation: boot-loader-reveal 100ms ease-out 1s forwards");
    expect(layout).toContain("<AppLoader deferIndicator />");
  });
});
