import { test, expect, describe, mock } from "bun:test";

/**
 * The contract that inline chrome depends on: a terminal server error comes
 * back as a VALUE, so the component that asked keeps rendering.
 *
 * The error that motivates this is deploy skew. Web ships on every push to
 * main; convex ships when someone runs deploy.sh. In between, the live bundle
 * calls functions prod does not have and each answers "Could not find public
 * function". Convex classes that as terminal, and its own useQuery re-throws
 * terminal errors during render — so on 2026-08-11 a header pill asking for
 * devices.getConversationMachine took the whole conversation view down with it.
 *
 * These tests render for real through react-dom/server, faking only the
 * transport, so a regression here fails as a thrown render rather than as a
 * changed return shape.
 */

// Two process-wide hazards, both from component tests that load before this
// file (bun loads test files in path order, and CI runs a plain `bun test`):
//
//   1. Several of them replace THIS module with a stub — EntityIdPill's test,
//      TmuxAttachPill's. mock.restore() undoes those registrations.
//   2. They also evaluate the real hook, which caches it with whatever
//      convex/react was mocked to at that moment. restore() cannot rebind a
//      cached module, so the import below asks for a FRESH copy that binds to
//      the transport this file installs.
//
// Without both, the hook's only test silently exercises someone else's stub.
mock.restore();

const { makeFunctionReference } = await import("convex/server");
const SOME_QUERY = makeFunctionReference<"query">("devices:getConversationMachine");

// What convex hands back for a function the deployment doesn't have.
const missingFunction = new Error(
  "[Request ID: e460f7bdf61343dc] Server Error\nCould not find public function for 'devices:getConversationMachine'.",
);

// useQueries is the transport underneath both convex's useQuery and ours. It
// reports a terminal failure by putting the Error in the result slot; the
// re-throw that crashes components lives in useQuery, one layer up.
let transport: (queries: Record<string, unknown>) => Record<string, unknown> = () => ({});
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQueries: (queries: Record<string, unknown>) => transport(queries),
}));

const { useQueryNoThrow } = await import(`${import.meta.dir}/../useQueryNoThrow.ts?fresh`);
const { renderToStaticMarkup } = await import("react-dom/server");

/** Renders a component that asks for the query and prints what it got. */
function renderProbe(args: Record<string, unknown> | "skip") {
  function Probe() {
    const { data, error } = useQueryNoThrow(SOME_QUERY, args as any);
    return (
      <span data-error={error ? "yes" : "no"}>{data ? String(data) : "fallback"}</span>
    );
  }
  return renderToStaticMarkup(<Probe />);
}

describe("useQueryNoThrow", () => {
  test("a metadata timeout leaves cached conversation content renderable", () => {
    const timeout = new Error("Your request timed out performing too many system operations.");
    transport = () => ({ value: timeout });
    const query = makeFunctionReference<"query">("conversations:getConversationWithMeta");
    function Conversation() {
      const { data, error } = useQueryNoThrow(query, { conversation_id: "abc" });
      expect(data).toBeUndefined();
      expect(error).toBe(timeout);
      return <article>Cached transcript<textarea aria-label="Reply" /></article>;
    }
    const html = renderToStaticMarkup(<Conversation />);
    expect(html).toContain("Cached transcript");
    expect(html).toContain('aria-label="Reply"');
  });

  test("a missing backend function renders instead of throwing", () => {
    transport = () => ({ value: missingFunction });
    // The assertion IS that this call returns: convex's useQuery would throw
    // here, unmounting whatever subscribed into its nearest ErrorBoundary.
    const html = renderProbe({ conversation_id: "abc" });
    expect(html).toContain("fallback");
    expect(html).toContain('data-error="yes"');
  });

  test("the error comes back as a value the caller can branch on", () => {
    transport = () => ({ value: missingFunction });
    let seen: Error | undefined;
    function Probe() {
      seen = useQueryNoThrow(SOME_QUERY, { conversation_id: "abc" } as any).error;
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(seen).toBe(missingFunction);
  });

  test("a resolved value passes straight through", () => {
    transport = () => ({ value: "a-machine" });
    const html = renderProbe({ conversation_id: "abc" });
    expect(html).toContain("a-machine");
    expect(html).toContain('data-error="no"');
  });

  // Loading and failed must stay distinguishable — callers that show a spinner
  // would otherwise spin forever on a query that already failed.
  test("loading is undefined data with no error", () => {
    transport = () => ({ value: undefined });
    const html = renderProbe({ conversation_id: "abc" });
    expect(html).toContain("fallback");
    expect(html).toContain('data-error="no"');
  });

  test("skip subscribes to nothing", () => {
    let requested: Record<string, unknown> | null = null;
    transport = (queries) => {
      requested = queries;
      return {};
    };
    const html = renderProbe("skip");
    expect(Object.keys(requested ?? {})).toHaveLength(0);
    expect(html).toContain("fallback");
    expect(html).toContain('data-error="no"');
  });
});
