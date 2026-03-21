import { CommandPalette } from "../../components/CommandPalette";
import { ShortcutProvider } from "../../shortcuts";

export default function PalettePage() {
  return (
    <ShortcutProvider>
      <div className="h-screen w-screen flex items-start justify-center pt-2">
        <CommandPalette standalone />
      </div>
    </ShortcutProvider>
  );
}
