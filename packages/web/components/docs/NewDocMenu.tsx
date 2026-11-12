// The docs list's New: what lives in Docs (a doc, board, sheet, dashboard) and
// the templates to start one from. The rows come from hooks/useCreateKinds,
// the list the header's New and the palette's Create group draw too, so every
// way to make a doc offers the same things and makes them the same way.
import { useState, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { KeyCap } from "../KeyCap";
import { inAppCreateEnv, useCreateKinds, type CreateKind } from "../../hooks/useCreateKinds";

export function NewDocMenu({ children }: { children: ReactElement }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const kinds = useCreateKinds().filter((k) => k.doc);
  const types = kinds.filter((k) => !k.template);
  const templates = kinds.filter((k) => k.template);
  const create = (k: CreateKind) => {
    setOpen(false);
    k.run(inAppCreateEnv((href) => router.push(href)));
  };
  const row = (k: CreateKind) => (
    <DropdownMenuItem key={k.id} data-new-doc={k.id} onSelect={() => create(k)} className="gap-2.5 rounded-md px-2 py-1.5 text-[13px]">
      {/* One slot for every row's mark, so the names line up whether it is an icon or a template's art. */}
      <span className="w-6 h-6 shrink-0 inline-flex items-center justify-center">
        {k.art ? <img src={k.art} alt="" className="h-6 w-6 object-contain" /> : <k.icon className={`h-4 w-4 ${k.tone}`} strokeWidth={1.75} />}
      </span>
      <span className="flex-1 truncate">{k.noun}</span>
      {k.template && k.makes && <span className={`text-meta ${k.tone}`}>{k.makes}</span>}
      {k.key && <KeyCap size="xs">{k.key.toUpperCase()}</KeyCap>}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        collisionPadding={8}
        data-owns-keys=""
        className="min-w-[200px] rounded-lg p-1"
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const k = types.find((x) => x.key === e.key.toLowerCase());
          if (!k) return;
          e.preventDefault();
          create(k);
        }}
      >
        {types.map(row)}
        {templates.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2 py-1 text-meta font-normal text-sol-text-dim">Templates</DropdownMenuLabel>
            {templates.map(row)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
