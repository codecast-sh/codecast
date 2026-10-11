"use client";
// A project's expectations in a side panel (the-line-model.md LM5; line-map.md
// LX3 Definition, LX5 editing in place): the line map's node panel and the
// Line tab of a project whose line has nothing on it yet. The document itself
// is the one the project's Expectations tab shows (components/expectations),
// in its compact form, with a way to the full page.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { useProjectExpectations } from "../../../hooks/useSyncProjectExpectations";
import { shortDay } from "../../../lib/line/runReport";
import { EXPECTATIONS_ABOUT, expectationsHref, openProposals } from "../../../lib/expectations/view";
import { cn } from "../../../lib/utils";
import { ReportSection } from "../RunReport";
import { ExpectationsDocument } from "../../expectations/ExpectationsDocument";

export function ExpectationsPanel({ projectId, setupHref, scroll = true, className }: {
  projectId: string;
  /** Puts setting up the line in the header, for a project whose expectations lead its tab. */
  setupHref?: string;
  /** Caps the height and scrolls, for a panel beside other sections. */
  scroll?: boolean;
  className?: string;
}) {
  const row = useProjectExpectations(projectId);
  const doc = row?.doc ?? null;
  const open = openProposals(row).length;
  const shortId = useInboxStore((s) => (s.projects as Record<string, any>)[projectId]?.short_id as string | undefined);
  const aside = (
    <span className="inline-flex items-center gap-3">
      {doc && (
        <span title={doc.applied_by ? `Version ${doc.version}, applied by ${doc.applied_by}${doc.how === "auto" ? " on its own (every line in a person's words)" : ""}` : undefined} data-expectations-version>
          version {doc.version} · {shortDay(doc.applied_at)}{open ? <span className="text-sol-yellow"> · {open} proposed</span> : null}
        </span>
      )}
      <Link href={expectationsHref(shortId ?? projectId)} className="inline-flex items-center gap-1 text-sol-cyan hover:underline" data-expectations-open-page>Open<ArrowRight className="w-3 h-3" /></Link>
      {setupHref && <Link href={setupHref} className="inline-flex items-center gap-1 text-sol-cyan hover:underline" data-line-setup-action>Set up the line<ArrowRight className="w-3 h-3" /></Link>}
    </span>
  );
  return (
    <ReportSection title="Expectations" aside={aside} className={className}>
      <div data-expectations-panel={projectId}>
        <p className="-mt-1 mb-3 text-[12px] text-sol-text-dim" data-expectations-about>{EXPECTATIONS_ABOUT}</p>
        <div className={cn(scroll && "max-h-[30rem] overflow-y-auto pr-1 -mr-1")}>
          <ExpectationsDocument projectId={projectId} variant="panel" />
        </div>
      </div>
    </ReportSection>
  );
}
