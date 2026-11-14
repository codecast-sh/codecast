// The selection bar's commands (BoardSelectionBar), which the keyboard and
// the right-click menu run too: one switch over the selected elements that
// writes through the live handle.
import type { MutableRefObject } from "react";
import { newElementKey } from "@codecast/shared/artifacts";
import { alignBoxes, bottomZ, distributeBoxes, elementBounds, elementBox, frameAround, intersects, nextZ, tidyBoxes, unionBox, type Box } from "@codecast/shared/artifacts/board";
import type { LiveViewProps } from "../live/registry";
import type { BarAction } from "./BoardSelectionBar";
import type { PromptMode } from "./BoardPrompt";
import type { BoardEl } from "./boardTypes";
import { stickiesToTasks } from "./boardActions";

export type BoardBarContext = {
  live: LiveViewProps["live"];
  selection: string[];
  selectedEls: BoardEl[];
  allEls: () => BoardEl[];
  byKeyRef: MutableRefObject<Map<string, BoardEl>>;
  setSelection: (keys: string[]) => void;
  startEdit: (key: string) => void;
  openAsk: (m: PromptMode) => void;
  duplicate: () => void;
  deleteSelection: () => void;
  root: HTMLElement | null;
  docTitle: string;
};

export function runBoardBar(a: BarAction, c: BoardBarContext) {
  const { live, selection, selectedEls, allEls, byKeyRef, setSelection, startEdit, openAsk, duplicate, deleteSelection, root, docTitle } = c;
  const boxes = new Map(selectedEls.filter((e) => e.kind !== "connector").map((e) => [e.key, elementBox(e)]));
  switch (a.type) {
    case "set":
      live.apply(selectedEls.filter((e) => !a.kinds || a.kinds.includes(e.kind)).filter((e) => {
        if ("color" in a.fields) return ["sticky", "shape", "frame", "text", "connector", "pen"].includes(e.kind);
        return true;
      }).map((e) => ({ k: e.key, set: a.fields })));
      return;
    case "align":
      live.apply([...alignBoxes(boxes, a.mode)].map(([k, p]) => ({ k, set: { x: p.x, y: p.y } })));
      return;
    case "tidy":
      live.apply([...tidyBoxes(boxes)].map(([k, p]) => ({ k, set: { x: p.x, y: p.y } })));
      return;
    case "distribute":
      live.apply([...distributeBoxes(boxes, a.axis)].map(([k, p]) => ({ k, set: { x: p.x, y: p.y } })));
      return;
    case "group": {
      const g = newElementKey("g");
      live.apply(selection.map((k) => ({ k, set: { group: g } })));
      return;
    }
    case "ungroup":
      live.apply(selection.map((k) => ({ k, set: { group: null } })));
      return;
    case "order": {
      let z = a.where === "front" ? nextZ({ elements: allEls() }) : bottomZ({ elements: allEls() }) - selection.length;
      const sorted = [...selectedEls].sort((x, y) => (Number(x.z) || 0) - (Number(y.z) || 0));
      live.apply(sorted.map((e) => ({ k: e.key, set: { z: z++ } })));
      return;
    }
    case "tasks":
    case "plan": {
      const stickies = selectedEls.filter((e) => e.kind === "sticky");
      const frame = selectedEls.find((e) => e.kind === "frame");
      const title = a.type === "plan" ? String(frame?.title || stickies[0]?.text?.toString().split("\n")[0] || docTitle) : undefined;
      void stickiesToTasks(live, stickies, allEls(), title, (k) => byKeyRef.current.get(k));
      return;
    }
    case "describe":
      openAsk("describe");
      return;
    case "edit":
      if (selection.length === 1) startEdit(selection[0]);
      return;
    case "frame": {
      // Wrap what is selected in a new frame, title ready to type, as FigJam's Frame selection does.
      const inside = selectedEls.filter((e) => e.kind !== "connector").map(elementBounds);
      // Even padding, as wide as it can be without reaching into what is not being framed.
      const sel = new Set(selection);
      // Neighbouring frames count too, with their titles; a frame the selection sits inside does not.
      const held = unionBox(inside);
      const others = allEls().filter((e) => !sel.has(e.key) && e.kind !== "connector").flatMap((e) => {
        const o = elementBounds(e);
        if (e.kind !== "frame") return [o];
        if (held && o.x <= held.x && o.y <= held.y && o.x + o.w >= held.x + held.w && o.y + o.h >= held.y + held.h) return [];
        return [{ ...o, y: o.y - 28, h: o.h + 28 }];
      });
      const pad = [24, 16, 8, 0].find((p) => {
        const f = frameAround(inside, "Frame", 0, p);
        if (!f || !("put" in f)) return true;
        const b = f.put as unknown as Box;
        // The new frame's own title sits above it.
        const withTitle = { x: b.x, y: b.y - 28, w: b.w, h: b.h + 28 };
        return !others.some((o) => intersects(withTitle, { x: o.x + 1, y: o.y + 1, w: o.w - 2, h: o.h - 2 }));
      }) ?? 0;
      const op = frameAround(inside, "Frame", bottomZ({ elements: allEls() }), pad);
      if (!op) return;
      live.apply([op]);
      byKeyRef.current.set(op.k, { ...("put" in op ? (op.put as any) : {}), key: op.k, rev: 0 });
      setSelection([op.k]);
      startEdit(op.k);
      return;
    }
    case "open": {
      const node = root?.querySelector(`[data-key="${CSS.escape(selection[0])}"] a[href]`) as HTMLAnchorElement | null;
      node?.click();
      return;
    }
    case "duplicate":
      duplicate();
      break;
    case "delete":
      deleteSelection();
  }
}
