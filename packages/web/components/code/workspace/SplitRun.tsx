// The panels of a split, along one axis, with hairlines between them.

import { useMemo, useRef, type ReactNode } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { useWatchEffect } from "../../../hooks/useWatchEffect";

const separatorClass = {
  horizontal:
    "relative z-10 w-px bg-sol-border/50 before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan",
  vertical:
    "relative z-10 h-px bg-sol-border/50 before:absolute before:inset-x-0 before:-top-[2px] before:-bottom-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan",
};

/** One run of a split: panels along one axis with hairlines between them.
 *  Sizes set by a command (<C-w>=, <C-w>_, 5<C-w><) reach the panels here; a
 *  drag already shows its sizes and comes back equal, so it sets nothing. */
export function SplitRun({
  orientation,
  ids,
  sizes,
  minSize,
  onSizes,
  children,
}: {
  orientation: "horizontal" | "vertical";
  ids: string[];
  sizes: number[] | null;
  /** Percent, so it can always be met. */
  minSize: number;
  onSizes(sizes: number[]): void;
  children(id: string, index: number): ReactNode;
}) {
  const key = ids.join(",");
  const want = sizes && sizes.length === ids.length ? sizes : ids.map(() => 100 / ids.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const defaultLayout = useMemo(() => Object.fromEntries(ids.map((id, i) => [id, want[i]])), [key]);
  const groupRef = useGroupRef();
  const live = useRef({ ids, onSizes });
  live.current = { ids, onSizes };
  useWatchEffect(() => {
    const handle = groupRef.current;
    if (!handle || ids.length < 2) return;
    const have = handle.getLayout();
    if (ids.every((id, i) => Math.abs((have[id] ?? 0) - want[i]) < 0.5)) return;
    handle.setLayout(Object.fromEntries(ids.map((id, i) => [id, want[i]])));
  }, [want.join(","), key]);
  return (
    <Group
      groupRef={groupRef}
      orientation={orientation}
      className="h-full min-h-0"
      defaultLayout={defaultLayout}
      onLayoutChanged={(l) => {
        const { ids: now, onSizes: emit } = live.current;
        if (now.length > 1) emit(now.map((id) => l[id] ?? 0));
      }}
    >
      {ids.map((id, i) => (
        <SplitPanel key={id} id={id} separator={i > 0 ? orientation : null} minSize={minSize}>
          {children(id, i)}
        </SplitPanel>
      ))}
    </Group>
  );
}

function SplitPanel({ id, separator, minSize, children }: { id: string; separator: "horizontal" | "vertical" | null; minSize: number; children: ReactNode }) {
  return (
    <>
      {separator && <Separator className={separatorClass[separator]} />}
      <Panel id={id} minSize={`${minSize}%`} className="min-h-0 min-w-0">
        {children}
      </Panel>
    </>
  );
}
