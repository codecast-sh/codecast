// The board's right-click menu, drawn by the app's one context menu. BoardView
// builds the verbs for what was clicked (an element, or the empty canvas);
// each runs the same command its shortcut runs.
import { ContextMenu, CtxItem, CtxSeparator, type ContextMenuState } from "../ui/context-menu";
import { KeyCap } from "../KeyCap";

export type BoardMenuItem = {
  label: string;
  /** The keys that do the same, shown as keycaps at the right. */
  keys?: string[];
  danger?: boolean;
  run(): void;
} | "sep";

/** What was right-clicked: an element's key (null for the canvas) and the board point. */
export type BoardMenuPayload = { key: string | null; world: { x: number; y: number } };

export function BoardContextMenu({ state, items }: { state: ContextMenuState<BoardMenuPayload>; items(p: BoardMenuPayload): BoardMenuItem[] }) {
  return (
    <ContextMenu state={state}>
      {(payload) =>
        items(payload).map((it, i) =>
          it === "sep" ? (
            <CtxSeparator key={`sep${i}`} />
          ) : (
            <CtxItem
              key={it.label}
              danger={it.danger}
              onSelect={() => it.run()}
              trailing={it.keys ? <span style={{ display: "inline-flex", gap: 3 }}>{it.keys.map((k) => <KeyCap key={k}>{k}</KeyCap>)}</span> : undefined}
            >
              {it.label}
            </CtxItem>
          ),
        )
      }
    </ContextMenu>
  );
}
