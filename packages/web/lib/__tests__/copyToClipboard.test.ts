import { afterEach, describe, expect, test } from "bun:test";
import { copyToClipboard } from "../utils";

// Regression for the InviteModal "Copy" bug: inside a Radix dialog the focus
// trap yanks focus off a body-level hidden textarea, so an execCommand-first
// copy silently grabs nothing while reporting success. The helper must prefer
// the async Clipboard API and, when falling back, park the textarea inside the
// open dialog where the trap can't steal focus from it.

type FakeTextArea = {
  value: string;
  style: { cssText: string };
  focus: () => void;
  select: () => void;
};

function makeFakeDom(opts: {
  execResult?: boolean;
  dialogHost?: boolean;
}) {
  const appendedTo: string[] = [];
  const textArea: FakeTextArea = {
    value: "",
    style: { cssText: "" },
    focus: () => {},
    select: () => {},
  };
  let execCalls = 0;
  const dialog = {
    name: "dialog",
    appendChild: () => appendedTo.push("dialog"),
    removeChild: () => {},
  };
  const doc = {
    createElement: () => textArea,
    execCommand: () => {
      execCalls++;
      return opts.execResult ?? true;
    },
    activeElement: opts.dialogHost
      ? { closest: (sel: string) => (sel === '[role="dialog"]' ? dialog : null) }
      : null,
    body: {
      appendChild: () => appendedTo.push("body"),
      removeChild: () => {},
    },
  };
  return { doc, textArea, appendedTo, execCalls: () => execCalls };
}

const originalDocument = (globalThis as { document?: unknown }).document;
const originalNavigator = globalThis.navigator;

function stubGlobals(doc: unknown, clipboard: unknown) {
  (globalThis as { document?: unknown }).document = doc;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard },
    configurable: true,
  });
}

afterEach(() => {
  (globalThis as { document?: unknown }).document = originalDocument;
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
  });
});

describe("copyToClipboard", () => {
  test("prefers the async Clipboard API and never touches execCommand", async () => {
    const dom = makeFakeDom({});
    let written: string | null = null;
    stubGlobals(dom.doc, {
      writeText: (t: string) => {
        written = t;
        return Promise.resolve();
      },
    });
    await copyToClipboard("hello");
    expect(written).toBe("hello");
    expect(dom.execCalls()).toBe(0);
  });

  test("falls back to execCommand inside the open dialog when writeText fails", async () => {
    const dom = makeFakeDom({ execResult: true, dialogHost: true });
    stubGlobals(dom.doc, {
      writeText: () => Promise.reject(new Error("Document is not focused")),
    });
    await copyToClipboard("hello");
    expect(dom.execCalls()).toBe(1);
    // The textarea must land inside the dialog, not on body — a body-level
    // textarea loses focus to the dialog's trap and copies nothing.
    expect(dom.appendedTo).toEqual(["dialog"]);
    expect(dom.textArea.value).toBe("hello");
  });

  test("uses body as the fallback host outside a dialog", async () => {
    const dom = makeFakeDom({ execResult: true });
    stubGlobals(dom.doc, undefined);
    await copyToClipboard("hello");
    expect(dom.appendedTo).toEqual(["body"]);
  });

  test("rejects when both paths fail so callers can toast the truth", async () => {
    const dom = makeFakeDom({ execResult: false });
    stubGlobals(dom.doc, {
      writeText: () => Promise.reject(new Error("nope")),
    });
    await expect(copyToClipboard("hello")).rejects.toThrow("Copy to clipboard failed");
  });
});
