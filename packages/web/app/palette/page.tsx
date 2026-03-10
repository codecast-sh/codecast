"use client";

import { CommandPalette } from "../../components/CommandPalette";

export default function PalettePage() {
  return (
    <div className="h-screen w-screen flex items-start justify-center pt-2">
      <CommandPalette standalone />
    </div>
  );
}
