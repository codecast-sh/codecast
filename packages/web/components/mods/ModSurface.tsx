// A mounted surface of a mod: asks the runtime to draw it, keeps the last good
// tree on screen while a redraw is in flight, and says plainly when the mod is
// off, still loading, failed to load, or threw while drawing. Used by the mod
// pane page and by fences in any markdown.

import { useCallback, useId, useMemo } from "react";
import type { ModNode, ModSurface } from "@codecast/shared/contracts/mods";
import { CodeBlock } from "../CodeBlock";
import { ErrorBoundary } from "../ErrorBoundary";
import { DynamicIcon } from "lucide-react/dynamic";
import { BlockFrame } from "../BlockFrame";
import { ModTree, rootCard } from "./ModTree";
import { modHost, modNavigate, type ModRuntime } from "../../lib/mods/host";
import { useModHostVersion, useModSurface } from "../../lib/mods/useMods";

function ErrorBox({ title, text, retry }: { title: string; text: string; retry?: () => void }) {
  return (
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--sol-red)_40%,var(--sol-border))] bg-[color-mix(in_srgb,var(--sol-red)_6%,var(--sol-card))] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 text-[12.5px] font-medium text-sol-red">{title}</div>
        {retry ? <button onClick={retry} className="text-[12px] text-sol-text-muted hover:text-sol-text">Try again</button> : null}
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] text-sol-text-muted max-h-48 overflow-auto">{text}</pre>
    </div>
  );
}

/** The frame a surface wears inline in a message: the block's name, and what copy and show-source give. */
export type SurfaceFrame = { title: string; icon?: string; source: string; lang: string };

export function ModSurfaceView({ runtime, surface, instance, fallback, frame }: { runtime: ModRuntime | undefined; surface: ModSurface; instance?: string; fallback?: React.ReactNode; frame?: SurfaceFrame }) {
  const autoId = useId();
  const state = useModSurface(runtime, surface, instance ?? autoId);
  const invoke = useCallback((fn: string, args: unknown[]) => { void runtime?.invoke(fn, args); }, [runtime]);
  if (!runtime) return <>{fallback ?? null}</>;
  if (runtime.status === "failed") return <ErrorBox title={`${runtime.row.title ?? runtime.row.name} failed to load`} text={runtime.error ?? "unknown error"} />;
  if (state.pass && state.tree === null && fallback) return <>{fallback}</>;
  const name = runtime.row.title ?? runtime.row.name;
  const tree = (
    // A tree that throws while drawing breaks only its own surface, never the sidebar or conversation around it.
    <ErrorBoundary key={runtime.row.rev} name={`mod:${runtime.row.name}`} fallback={({ error }) => <ErrorBox title={`${name} drew something codecast cannot show`} text={error.message} retry={state.retry} />}>
      <ModTree tree={state.tree} invoke={invoke} navigate={modNavigate} framed={!!frame} />
    </ErrorBoundary>
  );
  const body = (
    // A surface draws at the app's UI scale in the app's UI face wherever it
    // mounts: a fence sits inside a message's prose, whose link, list and
    // heading rules would otherwise restyle the mod's elements.
    <div className="not-prose min-w-0 text-[13px] leading-normal text-sol-text [font-family:var(--font-ui)]" data-mod={runtime.row.name}>
      {state.error && state.tree === undefined ? <ErrorBox title={`${name} could not draw this`} text={state.error} retry={state.retry} /> : null}
      {state.tree === undefined && !state.error ? <div className="h-16 animate-pulse rounded-lg bg-[color-mix(in_srgb,var(--sol-text)_4%,transparent)]" /> : null}
      {tree}
      {state.error && state.tree !== undefined ? <div className="mt-2 text-[11.5px] text-sol-red">The last redraw failed: {state.error.split("\n")[0]}</div> : null}
    </div>
  );
  if (!frame) return body;
  // A tree that is one Card is the frame's panel, and its title names the block.
  const card = rootCard(state.tree);
  const cardTitle = card?.p?.title;
  const panelPad = card ? "" : "px-3.5 py-3";
  return (
    <BlockFrame
      title={typeof cardTitle === "string" && cardTitle ? cardTitle : frame.title}
      actions={card?.p?.actions ? <ModTree tree={card.p.actions as ModNode} invoke={invoke} navigate={modNavigate} /> : undefined}
      icon={frame.icon ? <DynamicIcon name={frame.icon as any} size={13} className="shrink-0" /> : undefined}
      source={<CodeBlock code={frame.source} language={frame.lang} />}
      copyText={frame.source}
      measureKey={state.tree}
      fullscreen={() => <div className={`rounded-lg border border-sol-border/40 bg-sol-bg-alt ${panelPad}`}>{body}</div>}
    >
      <div className={panelPad}>{body}</div>
    </BlockFrame>
  );
}

/** A ```<lang> block some enabled mod draws, in the frame every rich block wears. Falls back to plain code when the mod is off or passes. */
export function ModFence({ lang, code }: { lang: string; code: string }) {
  useModHostVersion();
  const runtime = modHost.forFence(lang);
  const surface = useMemo<ModSurface>(() => ({ kind: "fence", id: lang, props: { code } }), [lang, code]);
  const plain = <CodeBlock code={code} language={lang} />;
  if (!runtime) return plain;
  const frame: SurfaceFrame = { title: `${runtime.row.title ?? runtime.row.name} · ${lang}`, icon: runtime.row.manifest?.icon, source: code, lang };
  return <ModSurfaceView runtime={runtime} surface={surface} fallback={plain} frame={frame} />;
}
