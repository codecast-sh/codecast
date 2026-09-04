import { useLayoutEffect } from "react";
import type { PaletteAction } from "./paletteActions";

type SessionCommand = PaletteAction & { run: () => void; available?: boolean };
const commands = new Map<string, SessionCommand[]>();

export function usePaletteSessionCommands(id: string | undefined, actions: SessionCommand[]) {
  useLayoutEffect(() => {
    if (!id) return;
    const available = actions.filter(action => action.available !== false);
    commands.set(id, available);
    return () => { if (commands.get(id) === available) commands.delete(id); };
  }, [id, actions]);
}

export function getPaletteSessionCommands(id: string): SessionCommand[] {
  return commands.get(id) ?? [];
}
