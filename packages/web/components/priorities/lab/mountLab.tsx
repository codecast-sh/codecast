// Dev-only bridge for the throwaway lab: the router's route table is a tracked
// file, so instead of registering /priorities-lab this renders the lab over the
// mounted /priorities page, inside the same context providers (read off the
// page's fiber ancestors). Run from the console on /priorities:
//   (await import("/components/priorities/lab/mountLab.tsx")).mountLab()
import { createElement, type Context, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import Page from "../../../app/priorities-lab/page";

let root: Root | null = null;

export function mountLab(): string {
  // The live list, or (in a workspace with Priorities off) its "is off" notice.
  const off = [...document.querySelectorAll("p")].find((p) => /Priorities is off/.test(p.textContent ?? ""));
  const anchor = document.querySelector("[data-priorities]") ?? off;
  const frame = anchor?.closest("[data-main-scroll]")?.parentElement ?? (off?.closest(".overflow-y-auto") as HTMLElement | null);
  if (!anchor || !frame) return "no /priorities page mounted";
  const fiberKey = Object.keys(anchor).find((k) => k.startsWith("__reactFiber$"));
  if (!fiberKey) return "no fiber";
  const providers: Array<{ ctx: Context<unknown>; value: unknown }> = [];
  for (let f = (anchor as any)[fiberKey]; f; f = f.return) {
    const t = f.type;
    if (f.tag === 10 && t) providers.push({ ctx: (t._context ?? t) as Context<unknown>, value: f.memoizedProps?.value });
  }
  let host = document.getElementById("priorities-lab-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "priorities-lab-root";
    host.className = anchor === off ? "flex-1 min-h-0" : frame.className;
    frame.parentElement!.insertBefore(host, frame);
  }
  (frame as HTMLElement).style.display = "none";
  // Outermost provider first (the walk went innermost first).
  const tree = providers.reduce<ReactNode>((child, { ctx, value }) => createElement(ctx as any, { value }, child), createElement(Page));
  root?.unmount();
  root = createRoot(host);
  root.render(tree);
  return `mounted with ${providers.length} providers`;
}
