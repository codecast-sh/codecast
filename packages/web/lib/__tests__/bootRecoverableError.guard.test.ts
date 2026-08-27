import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// RECOVERABLE RENDER ERROR WIRING GUARD.
//
// React's default handler for a render it recovered from rethrows a wrapper
// whose message is only the React error code — in production, the unreadable
// "Minified React error #520" — with the failure that actually happened hidden
// in `cause`. That wrapper reached users as an "Uncaught" toast carrying
// nothing anyone could act on.
//
// createRoot must therefore take our handler. Dropping the option is silent:
// nothing breaks, reports just go back to naming a number. This guard fails
// when the option leaves the boot path.
//
// See components/__tests__/recoverableRenderError.test.tsx for the behaviour
// itself, driven through a real concurrent render that throws.

const boot = readFileSync(join(import.meta.dir, "..", "..", "src", "boot.tsx"), "utf8");

describe("boot wires React's recoverable render errors into reporting", () => {
  test("createRoot receives onRecoverableError", () => {
    const call = boot.slice(boot.indexOf("createRoot("));
    expect(call).toContain("onRecoverableError: reportRecoverableRenderError");
  });

  test("the handler is imported from the reporting layer", () => {
    expect(boot).toMatch(
      /import \{[^}]*reportRecoverableRenderError[^}]*\} from "\.\.\/lib\/analytics"/
    );
  });
});
