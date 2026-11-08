import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { appAlert, appPrompt, closePopup, orderedButtons, outsideTap, showActionSheet, usePopups } from "./popups";

const queue = () => usePopups.getState().queue;

beforeEach(() => usePopups.setState({ queue: [] }));

describe("the popup queue", () => {
  test("one popup at a time; the next waits its turn", () => {
    appAlert("First");
    showActionSheet("Second", [{ label: "Go", onPress: () => {} }]);
    expect(queue().map((p) => p.kind)).toEqual(["alert", "sheet"]);
    closePopup(queue()[0].id);
    expect(queue().map((p) => p.kind)).toEqual(["sheet"]);
  });

  test("a popup's action runs after it is gone, so one it opens shows next", () => {
    let seen = -1;
    appAlert("Ask", undefined, [{ text: "Go", onPress: () => { seen = queue().length; appAlert("Then"); } }]);
    closePopup(queue()[0].id, queue()[0].kind === "alert" ? (queue()[0] as any).buttons[0].onPress : undefined);
    expect(seen).toBe(0);
    expect(queue().map((p) => (p as any).title)).toEqual(["Then"]);
  });

  test("a notice gets one OK; a prompt defaults its confirm to OK", () => {
    appAlert("Saved");
    appPrompt("Name", { onSubmit: () => {} });
    expect((queue()[0] as any).buttons).toEqual([{ text: "OK" }]);
    expect((queue()[1] as any).confirm).toBe("OK");
  });
});

describe("a tap outside", () => {
  test("cancels a sheet, running its onCancel", () => {
    let cancelled = false;
    showActionSheet("Pick", [{ label: "A", onPress: () => {} }], { onCancel: () => { cancelled = true; } });
    const t = outsideTap(queue()[0]);
    t.run?.();
    expect(t.close).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("runs a dialog's cancel button, or its lone OK", () => {
    let which = "";
    appAlert("Sure?", undefined, [{ text: "Keep", style: "cancel", onPress: () => { which = "keep"; } }, { text: "Stop", style: "destructive" }]);
    outsideTap(queue()[0]).run?.();
    expect(which).toBe("keep");
    appAlert("Saved", undefined, [{ text: "OK", onPress: () => { which = "ok"; } }]);
    outsideTap(queue()[1]).run?.();
    expect(which).toBe("ok");
  });

  test("leaves up a dialog that asks for a real choice", () => {
    appAlert("Which?", undefined, [{ text: "A" }, { text: "B" }]);
    expect(outsideTap(queue()[0]).close).toBe(false);
  });
});

test("a dialog draws its cancel first", () => {
  expect(orderedButtons([{ text: "Delete", style: "destructive" }, { text: "Cancel", style: "cancel" }]).map((b) => b.text))
    .toEqual(["Cancel", "Delete"]);
});

// Every popup is the app's own (lib/popups, drawn by components/PopupHost):
// the system Alert and action sheet ignore the theme and the app's type.
test("no screen opens a system alert or action sheet", () => {
  const root = path.resolve(import.meta.dir, "..");
  const hits: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "ios", "android", ".expo", "dist", "targets", "store-shots"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name)) {
        const src = fs.readFileSync(p, "utf8");
        if (/\bAlert\.(alert|prompt)\(|\bActionSheetIOS\b/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))) {
          hits.push(path.relative(root, p));
        }
      }
    }
  })(root);
  expect(hits).toEqual([]);
});
