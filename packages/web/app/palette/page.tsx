"use client";

import { useEffect } from "react";
import { CommandPalette } from "../../components/CommandPalette";

export default function PalettePage() {
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  return (
    <div className="h-screen w-screen flex items-start justify-center pt-2" style={{ background: "transparent" }}>
      <CommandPalette standalone />
    </div>
  );
}
