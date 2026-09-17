import { test, expect, describe, mock } from "bun:test";

/**
 * THE feeder for the sessions cache must survive its own query failing.
 *
 * On 2026-09-16 conversations:listInboxSessions hit the backend's 1s user-code
 * cap ("Function execution timed out (maximum duration: 1s)") on a saturated
 * host. Convex classes that as terminal and its useQuery re-throws it during
 * render, so the throw climbed to the one ErrorBoundary around DashboardSync
 * and unmounted EVERY global feeder until the page was reloaded. The feeder
 * subscribes through useQueryNoThrow now: the error comes back as a value, the
 * cached rows keep painting, and the subscription re-runs on the next change.
 *
 * Rendered for real through react-dom/server with only the transport faked,
 * so a regression fails as a thrown render.
 */
mock.restore();

const { makeFunctionReference } = await import("convex/server");

const timeout = new Error(
  "[CONVEX Q(conversations:listInboxSessions)] [Request ID: 0018a80d31f3d6a1] Server Error\nFunction execution timed out (maximum duration: 1s)",
);

let transport: (queries: Record<string, unknown>) => Record<string, unknown> = () => ({});
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQueries: (queries: Record<string, unknown>) => transport(queries),
}));

const { useInboxStore } = await import("../../store/inboxStore");
const { useLiveInboxSessions } = await import(`${import.meta.dir}/../useLiveInboxSessions.ts?fresh`);
const { renderToStaticMarkup } = await import("react-dom/server");

const CACHED = "jx7cach0000000000000000000000aaa";

function Probe() {
  const { data, error } = useLiveInboxSessions();
  return <span data-error={error ? "yes" : "no"}>{data ? "live" : "cache"}</span>;
}

describe("useLiveInboxSessions under a terminal server error", () => {
  test("the 1s user-code timeout renders as a value and leaves the cached rows alone", () => {
    useInboxStore.setState({
      syncRole: "host",
      sessions: {
        [CACHED]: {
          _id: CACHED,
          session_id: "session-cached",
          updated_at: 1,
          agent_type: "claude_code",
          message_count: 5,
          is_idle: false,
          has_pending: false,
        } as any,
      },
    });
    transport = () => ({ value: timeout });

    const html = renderToStaticMarkup(<Probe />);

    expect(html).toBe('<span data-error="yes">cache</span>');
    expect(Object.keys(useInboxStore.getState().sessions)).toEqual([CACHED]);
  });

});
