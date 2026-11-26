import { afterEach, beforeEach, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { collectGhostSweepCandidates } from "../../hooks/ghostSweep";
import { cancelDraftWrite, scheduleDraftWrite } from "../../lib/pendingDraftWrites";
import { statusStarting } from "../../lib/sessionStatus";

// A second new session (Ctrl+N) used to hide the first one's typed prompt:
// the full new-session page's blank showed in NEW only while focused.

beforeEach(() => {
  useInboxStore.setState({
    sessions: {}, conversations: {}, pending: {}, pendingSessionCreates: {},
    drafts: {}, currentSessionId: null,
  });
});

function openBlank() {
  const s = useInboxStore.getState();
  const { stubId } = s.beginOptimisticSession({
    agentType: "claude_code", projectPath: "/repo", deferCreate: true,
    create: async () => "jx70000000000000000000000000test",
  });
  s.setCurrentSession(stubId);
  return stubId;
}

test("leaving a blank with a typed prompt keeps it as a draft", () => {
  const first = openBlank();
  useInboxStore.getState().setDraft(first, { draft_message: "half typed prompt" });
  openBlank();
  const state = useInboxStore.getState();
  expect(state.sessions[first]._hasDraft).toBe(true);
  expect(state.drafts[first]?.draft_message).toBe("half typed prompt");
  // The stub sweep leaves a kept draft alone, however old.
  expect(collectGhostSweepCandidates(state, Date.now() + 24 * 60 * 60 * 1000).stubs).not.toContain(first);
  // Its card reads Draft at once, not Starting through the start grace.
  expect(statusStarting(state.sessions[first], Date.now())).toBe(false);
});

test("a keystroke still in the debounce counts as typed", () => {
  const first = openBlank();
  scheduleDraftWrite(first, () => {});
  openBlank();
  cancelDraftWrite(first);
  expect(useInboxStore.getState().sessions[first]._hasDraft).toBe(true);
});

test("leaving an empty blank keeps nothing", () => {
  const first = openBlank();
  openBlank();
  expect(useInboxStore.getState().sessions[first]?._hasDraft).toBeUndefined();
});

afterEach(() => {
  useInboxStore.setState({ sessions: {}, drafts: {}, currentSessionId: null, pendingSessionCreates: {} });
});
