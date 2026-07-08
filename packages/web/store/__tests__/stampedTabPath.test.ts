import { afterEach, describe, expect, it } from "bun:test";
import { stampedTabPath, type AppTab } from "../inboxStore";

// stampedTabPath captures the live browser URL onto a tab when it's backgrounded.
// These pin the two invariants that keep a tab's pane mounted (so its scroll
// survives) across a switch:
//   1. the query string (?s=<id> deep link) is preserved, and
//   2. an inbox tab never adopts a /conversation/<id> route (which would swap
//      the rendered component and unmount the pane).

const tab = (path: string): AppTab => ({ id: "t", title: "", path, createdAt: 0 });

function withLocation(pathname: string, search: string, fn: () => void) {
  const prev = (globalThis as any).window;
  (globalThis as any).window = { location: { pathname, search } };
  try {
    fn();
  } finally {
    if (prev === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prev;
  }
}

describe("stampedTabPath", () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("preserves the ?s= deep link (pathname-only would drop it)", () => {
    withLocation("/inbox", "?s=conv123", () => {
      expect(stampedTabPath(tab("/inbox?s=conv123"))).toBe("/inbox?s=conv123");
    });
  });

  it("keeps an inbox tab on the inbox route when the URL canonicalized to /conversation/<id>", () => {
    // The inbox rewrites window.location to /conversation/<id> while a session is
    // open; the tab must stay /inbox so its pane doesn't re-match <Conversation>.
    withLocation("/conversation/conv123", "", () => {
      expect(stampedTabPath(tab("/inbox?s=oldconv"))).toBe("/inbox?s=conv123");
      expect(stampedTabPath(tab("/inbox"))).toBe("/inbox?s=conv123");
    });
  });

  it("leaves a standalone /conversation tab on its conversation route", () => {
    withLocation("/conversation/conv123", "", () => {
      expect(stampedTabPath(tab("/conversation/conv123"))).toBe("/conversation/conv123");
    });
  });

  it("does not rewrite a /conversation/<id>/diff sub-route", () => {
    withLocation("/conversation/conv123/diff", "", () => {
      expect(stampedTabPath(tab("/inbox"))).toBe("/conversation/conv123/diff");
    });
  });

  it("captures full path+search for non-inbox routes", () => {
    withLocation("/tasks", "?sort=assignee", () => {
      expect(stampedTabPath(tab("/tasks"))).toBe("/tasks?sort=assignee");
    });
  });

  it("returns the stored path under SSR (no window)", () => {
    delete (globalThis as any).window;
    expect(stampedTabPath(tab("/inbox?s=x"))).toBe("/inbox?s=x");
  });
});
