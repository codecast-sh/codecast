"use client";

import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Body, C, Section } from "./ui";
import { Shot } from "../kit";

/** The verbs on a trigger's page, in the order its button row shows them. */
const VERBS: { name: string; does: ReactNode }[] = [
  { name: "Run now", does: "Queue a run immediately. The regular cadence does not shift, and a precheck does not apply." },
  { name: "Pause", does: <>Skip every fire until you press <b>Resume</b>. Nothing is lost.</> },
  { name: "Cancel", does: "Retire it, after a confirm. The run history stays readable." },
  { name: "Reactivate", does: "On a finished or cancelled trigger: arm it again, one cycle from now." },
  { name: "Edit", does: "Change the prompt, title or schedule in the same form that made it." },
];

export function History() {
  return (
    <Section
      id="history"
      tint
      title="Every trigger has a page"
      lede={<>Open one from the Triggers list, or from the pill on the conversation that set it. The page holds the schedule, the controls, the precheck if there is one, every run so far, and the prompt in full.</>}
    >
      <Shot
        src="/features/triggers/trigger-page.webp"
        alt="A trigger's page in codecast: Evals: prompts changed, every 2h, next fire in 49m, buttons for Run now, Pause, Cancel and Edit, a Precheck panel showing the last skip, and a run history of skipped firings beside the briefing"
        width={1600}
        height={1026}
        caption={<>One of codecast&apos;s own triggers. It runs every two hours, but its precheck skips the run unless a prompt changed, so most of its history reads <b>skipped</b>.</>}
      />
      <div className="mt-10 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <dl className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${SOL.base2}`, backgroundColor: SOL.base3 }}>
          {VERBS.map((v, i) => (
            <div key={v.name} className="grid grid-cols-[110px_minmax(0,1fr)] gap-4 px-4 py-3" style={{ borderTop: i ? `1px solid ${SOL.base2}` : undefined }}>
              <dt className="font-mono text-[13px] font-semibold" style={{ color: SOL.base02 }}>{v.name}</dt>
              <dd className="text-[14px] leading-6" style={{ color: SOL.base01 }}>{v.does}</dd>
            </div>
          ))}
        </dl>
        <div className="space-y-4">
          <h3 className="font-mono text-[18px] font-bold" style={{ color: SOL.base03 }}>Edits are versions, not overwrites</h3>
          <Body>
            A trigger that runs for weeks gets tuned. Every edit, from the page or from an agent, writes a new version and keeps the old one, so you can always see what the prompt said when a given run fired.
          </Body>
          <Body>
            In the Triggers list each row carries the same controls inline (<b>Run now</b>, <b>Edit</b>), plus <b>Duplicate</b> and <b>Copy prompt</b>, and opens its run history in place.
          </Body>
          <Body className="!text-[14px]" >
            Reading the version history is in the CLI today: <C>cast trigger history tr-43</C> lists who changed which field, from what to what, and whether it came from the web or a session.
          </Body>
        </div>
      </div>
    </Section>
  );
}
