"use client";
// The trial's hold as a count that opens what it holds: the problems Problems
// lists under Not started for the trial project, counted by the Problems list
// itself (useProblemList over that project), so the figure here is the one the
// opened list shows.
import Link from "next/link";
import { useLineWorkspace, type LineWorkspace } from "../../hooks/useLineWorkspace";
import { useProblemList } from "../line/workspace/views/timeline/useProblemList";
import { readLineSelection } from "../../lib/line/lineWorkspaceUrl";
import type { LineModel } from "../../lib/line/lineModel";

const NOT_STARTED = { ...readLineSelection(null), view: "problems", status: "notstarted" } as ReturnType<typeof readLineSelection>;

export function TrialHeldLink({ projectId, href, why }: { projectId: string; href: string; why: string }) {
  const ws = useLineWorkspace(projectId, null);
  return ws.model ? <Counted model={ws.model} ws={ws} href={href} why={why} /> : <HeldLink href={href} why={why} n={null} />;
}

function Counted({ model, ws, href, why }: { model: LineModel; ws: LineWorkspace; href: string; why: string }) {
  const list = useProblemList(model, ws, NOT_STARTED);
  return <HeldLink href={href} why={why} n={list.counts.by.notstarted} />;
}

function HeldLink({ href, why, n }: { href: string; why: string; n: number | null }) {
  return (
    <Link href={href} title={why} className="font-semibold text-sol-yellow hover:underline" data-trial-dispatch-held>
      Held <span className="tabular-nums">{n ?? "…"}</span> <span className="font-normal">not started</span>
    </Link>
  );
}
