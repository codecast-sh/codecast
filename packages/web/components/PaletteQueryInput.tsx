import { forwardRef, startTransition, useImperativeHandle, useState, type ComponentProps } from "react";
import { Command as CommandPrimitive } from "cmdk";

export type PaletteQueryInputHandle = { set: (value: string) => void };

type Props = Omit<ComponentProps<typeof CommandPrimitive.Input>, "value" | "onValueChange"> & {
  initial: string;
  /** The typed text, handed over in a transition: the box shows each key at
   *  once, and the palette ranks and redraws its results in one render that
   *  the next key interrupts rather than waits on. */
  onQuery: (value: string) => void;
};

/** The palette's search box. It owns the text it shows, so a keystroke
 *  renders this box alone; the palette learns the text in a transition. A
 *  palette that changes the text itself (a filter completion, a drill in or
 *  out) sets it through the handle. */
export const PaletteQueryInput = forwardRef<PaletteQueryInputHandle, Props>(function PaletteQueryInput({ initial, onQuery, ...props }, ref) {
  const [text, setText] = useState(initial);
  useImperativeHandle(ref, () => ({ set: setText }), []);
  return (
    <CommandPrimitive.Input
      {...props}
      value={text}
      onValueChange={(value) => {
        setText(value);
        startTransition(() => onQuery(value));
      }}
    />
  );
});
