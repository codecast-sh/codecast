"use client";

// The header's New: one pill beside search that opens everything a person
// can create (hooks/useCreateKinds, the same list as the palette's Create
// group). Open, each row's letter picks it, so New then T is a task; Ctrl+N
// still starts a session from anywhere without the menu.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, SquarePen } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { KeyCap } from "./KeyCap";
import { inAppCreateEnv, useCreateKinds } from "../hooks/useCreateKinds";

export function NewMenu() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const kinds = useCreateKinds().filter((k) => !k.variant);
  const create = (run: (typeof kinds)[number]["run"]) => {
    setOpen(false);
    run(inAppCreateEnv((href) => router.push(href)));
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="New"
          className="group flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-sol-bg-alt pl-2.5 pr-2 text-[13px] text-sol-text transition-colors hover:bg-sol-bg-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/60 data-[state=open]:bg-sol-bg-highlight"
        >
          <SquarePen className="h-3.5 w-3.5 text-sol-cyan" strokeWidth={1.75} />
          New
          <ChevronDown className="h-3 w-3 text-sol-text-dim transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        // Its letters are its own, ahead of the conversation's h/t/d/r.
        data-owns-keys=""
        className="min-w-[200px] rounded-lg border-sol-border bg-sol-bg p-1 shadow-xl shadow-black/30"
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const kind = kinds.find((k) => k.key === e.key.toLowerCase());
          if (!kind) return;
          e.preventDefault();
          create(kind.run);
        }}
      >
        {kinds.map((k) => (
          <DropdownMenuItem
            key={k.id}
            onSelect={() => create(k.run)}
            className="gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-sol-text focus:bg-sol-bg-alt focus:text-sol-text"
          >
            <k.icon className={`h-4 w-4 ${k.tone}`} strokeWidth={1.75} />
            <span className="flex-1 truncate">{k.noun}</span>
            {k.key && <KeyCap size="xs">{k.key.toUpperCase()}</KeyCap>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
