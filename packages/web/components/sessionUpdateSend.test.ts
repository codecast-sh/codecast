import { describe, expect, test } from "bun:test";
import { parseSessionUpdateSend } from "./sessionUpdateSend";

describe("outgoing update presentation", () => {
  test("flags on either side preserve the body and report queued rather than sent", () => {
    for (const args of ['--update --request-id uuid "Tests passed" --from jx7source', '"Tests passed" --from=jx7source --update --request-id=uuid']) {
      expect(parseSessionUpdateSend(args, "Request ID: uuid\nQUEUED update-1 to jx7target\n")).toEqual({
        body: "Tests passed", kind: "literal", status: "queued", updateId: "update-1",
      });
    }
  });

  test("literal heredoc bodies retain their newlines and ignore flags inside them", () => {
    const args = "--update - --request-id uuid <<'EOF'\n  Tests passed\n\n--from literal text\nEOF";
    expect(parseSessionUpdateSend(args, "ENQUEUED update-1 to jx7target")).toMatchObject({
      body: "  Tests passed\n\n--from literal text", kind: "heredoc", status: "enqueued",
    });
  });

  test("a failure after submission remains unconfirmed and dynamic input stays a recipe", () => {
    expect(parseSessionUpdateSend('"$(cat report.md)" --update', "Request ID: uuid\nError: timeout")).toMatchObject({
      kind: "dynamic", status: "acceptance unconfirmed",
    });
    expect(parseSessionUpdateSend('"Update" --update', "")).toMatchObject({ status: "acceptance unconfirmed" });
  });

  test("quoted flags and heredoc prose do not turn an ordinary send into an update", () => {
    for (const args of ['"Mention --update in docs"', "- <<'EOF'\n--update\nEOF", '-- "--update"']) {
      expect(parseSessionUpdateSend(args, "sent")).toBeNull();
    }
  });

  test.each(["ENQUEUED", "CANCELLED", "REJECTED"])("shows the immutable server receipt state: %s", (state) => {
    expect(parseSessionUpdateSend('"Update" --update', `${state} update-1 to jx7target`)?.status).toBe(state.toLowerCase());
  });
});
