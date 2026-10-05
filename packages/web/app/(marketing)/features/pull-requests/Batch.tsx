"use client";

import { useState } from "react";
import { SOL } from "../../blog/blogChrome";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { C, Face, Frame, PAPER, PEOPLE, Prompt, SessionPill, T, Term } from "./kit";
import { NOTES, PR_NUMBER, REPO, REVIEWER, SESSION } from "./data";

type Verdict = "approve" | "request-changes" | "comment";
type Dest = "github" | "session";

const VERDICTS: { key: Verdict; label: string; color: string }[] = [
  { key: "comment", label: "Comment", color: SOL.blue },
  { key: "approve", label: "Approve", color: SOL.green },
  { key: "request-changes", label: "Request changes", color: SOL.orange },
];

/** The diff the Files mock shows: src/retry.ts around the two held notes. */
const DIFF: { n: number; kind: " " | "+" | "-"; text: string; note?: number }[] = [
  { n: 38, kind: " ", text: "export function nextDelay(attempt: number) {" },
  { n: 39, kind: "-", text: "  const base = 500 * attempt;" },
  { n: 39, kind: "+", text: "  const base = Math.min(CAP_MS, 500 * 2 ** attempt);" },
  { n: 40, kind: "+", text: "  const jitter = Math.random() * base * 0.2;" },
  { n: 41, kind: " ", text: "" },
  { n: 42, kind: "+", text: "  return base + jitter;", note: 0 },
  { n: 43, kind: " ", text: "}" },
];
const DIFF2: { n: number; kind: " " | "+" | "-"; text: string; note?: number }[] = [
  { n: 86, kind: " ", text: "  } catch (err) {" },
  { n: 87, kind: "+", text: "    await schedule(delivery, nextDelay(attempt));" },
  { n: 88, kind: "+", text: "    log.warn(\"delivery failed\", { id: delivery.id });", note: 1 },
  { n: 89, kind: " ", text: "  }" },
];

export function Batch() {
  const [verdict, setVerdict] = useState<Verdict>("request-changes");
  const [dest, setDest] = useState<Dest>("github");
  const body = verdict === "approve" ? "" : verdict === "comment" ? "Two small things." : "Two notes, then good to go.";

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-10 items-start">
      <div className="min-w-0">
        <FilesMock />
        <ReviewBar verdict={verdict} setVerdict={setVerdict} dest={dest} setDest={setDest} />
      </div>

      <div className="min-w-0 space-y-5 lg:sticky lg:top-24">
        <Term title="hold notes on lines, then look at the batch" wrap>
          <Prompt>cast pr comment {PR_NUMBER} --hold --file src/retry.ts --line 42 &quot;{NOTES[0].text}&quot;</Prompt>
          {T.green("ok")} held for your review of {T.cyan(`${REPO}#${PR_NUMBER}`)} {T.dim("(`cast pr notes` lists it, `cast pr review` sends the batch)")}{"\n"}
          <Prompt>cast pr notes {PR_NUMBER}</Prompt>
          {T.cyan(`${REPO}#${PR_NUMBER}`)} 2 held notes{"\n"}
          {NOTES.map((n) => <span key={n.id}>  {T.dim(n.id)}  {n.file}:{n.line}  {n.text}{"\n"}</span>)}
          {T.dim("`cast pr review --approve|--request-changes|--comment` sends them as one review.")}
        </Term>

        {dest === "github" ? (
          <Term title="send it as one review, under your own account" wrap>
            <Prompt>cast pr review {PR_NUMBER} --{verdict}{body ? ` -b "${body}"` : ""}</Prompt>
            {T.green("ok")} {verdict === "approve" ? T.green("approved") : verdict === "request-changes" ? T.yellow("requested changes on") : "commented on"} {T.cyan(`${REPO}#${PR_NUMBER}`)} {T.dim(`with 2 notes as ${REVIEWER} https://github.com/${REPO}/pull/${PR_NUMBER}#pullrequestreview-2841907733`)}{"\n"}
            {"   "}{T.dim(`delivered to session ${SESSION.id}`)}
          </Term>
        ) : (
          <div className="rounded-xl border p-4 font-mono text-[12px] leading-relaxed" style={{ borderColor: "rgba(42,161,152,0.35)", backgroundColor: "rgba(42,161,152,0.06)", color: SOL.base01 }}>
            <div className="font-semibold" style={{ color: SOL.cyan }}>Send to session, from the page</div>
            The notes go to <SessionPill>{SESSION.id}</SessionPill> as one message with no verdict, and stay held. The agent
            acts first; the same batch can still go to GitHub afterwards.
          </div>
        )}

        <p className="text-[14.5px] leading-[1.7]" style={{ color: SOL.base01 }}>
          {verdict === "approve"
            ? <>An approval needs no body. GitHub refuses an approval of your own pull request, and the refusal comes back in its own words.</>
            : <><C>--{verdict}</C> needs a body: <C>-b &quot;text&quot;</C>, or <C>-b -</C> to read it from stdin.</>}
          {" "}A verdict goes out under your GitHub account, never the app&apos;s, so it needs your account connected.
        </p>
      </div>
    </div>
  );
}

function DiffRows({ rows }: { rows: typeof DIFF }) {
  return (
    <>
      {rows.map((r, i) => {
        const bg = r.kind === "+" ? "rgba(133,153,0,0.09)" : r.kind === "-" ? "rgba(220,50,47,0.08)" : "transparent";
        const note = r.note !== undefined ? NOTES[r.note] : null;
        return (
          <div key={i}>
            <div className="group flex text-[11.5px] leading-[1.9]" style={{ backgroundColor: bg }}>
              <span className="relative w-10 shrink-0 pr-2 text-right tabular-nums select-none" style={{ color: SOL.base1 }}>
                {r.kind === "-" ? "" : r.n}
                <span className="absolute -right-2 top-1/2 -translate-y-1/2 hidden group-hover:inline-flex h-4 w-4 items-center justify-center rounded text-[11px] font-bold text-white" style={{ backgroundColor: SOL.blue }}>+</span>
              </span>
              <span className="w-5 shrink-0 text-center select-none" style={{ color: r.kind === "+" ? SOL.green : r.kind === "-" ? SOL.red : SOL.base1 }}>{r.kind}</span>
              <span className="whitespace-pre pr-4" style={{ color: SOL.base02 }}>{r.text}</span>
            </div>
            {note && (
              <div className="py-2 pl-3 pr-3 sm:pl-14" style={{ backgroundColor: "rgba(238,232,213,0.35)" }}>
                <div className="rounded-md border border-dashed px-3 py-2 font-sans" style={{ borderColor: "rgba(181,137,0,0.6)", backgroundColor: PAPER }}>
                  <div className="flex items-center gap-2 font-mono text-[10.5px]">
                    <Face name={REVIEWER} color={PEOPLE.omar} size={15} />
                    <span style={{ color: SOL.base02 }}>{REVIEWER}</span>
                    <span className="rounded-full border border-dashed px-1.5 text-[10px]" style={{ borderColor: "rgba(181,137,0,0.6)", color: SOL.yellow }}>held</span>
                  </div>
                  <div className="mt-1 text-[13px]" style={{ color: SOL.base02 }}>{note.text}</div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function FilesMock() {
  return (
    <Frame label="The Files view of the pull request page with two held notes, drawn dashed">
      <div className="flex items-center gap-4 px-4 pt-3 text-[11.5px]" style={{ color: SOL.base00 }}>
        {["Conversation", "Files 4", "Commits 3", "Checks 6"].map((t, i) => (
          <span key={t} className="pb-2 whitespace-nowrap" style={i === 1 ? { color: SOL.base03, borderBottom: `2px solid ${SOL.green}` } : undefined}>
            {t} <span className="hidden sm:inline"><KeyCap size="xs">{i + 1}</KeyCap></span>
          </span>
        ))}
      </div>
      <div className="grid sm:grid-cols-[150px_minmax(0,1fr)]" style={{ borderTop: `1px solid ${SOL.base2}` }}>
        <div className="hidden sm:block py-2 text-[11px]" style={{ borderRight: `1px solid ${SOL.base2}`, color: SOL.base00 }}>
          {[
            { f: "src/retry.ts", held: 2 },
            { f: "src/queue.ts" },
            { f: "test/retry.test.ts" },
            { f: "README.md", viewed: true },
          ].map((x) => (
            <div key={x.f} className="flex items-center gap-1.5 px-3 py-1" style={{ opacity: x.viewed ? 0.45 : 1, backgroundColor: x.held ? "rgba(38,139,210,0.07)" : undefined }}>
              <span className="min-w-0 flex-1 truncate">{x.f.split("/").pop()}</span>
              {x.held && <span className="rounded-full border border-dashed px-1 text-[9.5px]" style={{ borderColor: "rgba(181,137,0,0.6)", color: SOL.yellow }}>{x.held}</span>}
            </div>
          ))}
        </div>
        <div className="min-w-0 overflow-x-auto">
          <div className="flex items-center justify-between px-3 py-1.5 text-[11px]" style={{ backgroundColor: SOL.base2 + "70", color: SOL.base01 }}>
            <span>src/retry.ts</span>
            <span><span style={{ color: SOL.green }}>+21</span> <span style={{ color: SOL.red }}>-6</span></span>
          </div>
          <DiffRows rows={DIFF} />
          <div className="px-3 py-1 text-[10.5px]" style={{ color: SOL.base1, backgroundColor: "rgba(38,139,210,0.05)" }}>⋯ 42 unchanged lines</div>
          <DiffRows rows={DIFF2} />
        </div>
      </div>
      <div className="hidden sm:flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[10.5px]" style={{ borderTop: `1px solid ${SOL.base2}`, color: SOL.base1 }}>
        <span><KeyCap size="xs">n</KeyCap> <KeyCap size="xs">p</KeyCap> walk threads</span>
        <span><KeyCap size="xs">m</KeyCap> mark viewed, next file</span>
        <span><KeyCap size="xs">r</KeyCap> review menu</span>
      </div>
    </Frame>
  );
}

function ReviewBar({ verdict, setVerdict, dest, setDest }: { verdict: Verdict; setVerdict: (v: Verdict) => void; dest: Dest; setDest: (d: Dest) => void }) {
  return (
    <div className="mt-4 rounded-lg border px-4 py-3 font-mono" style={{ borderColor: "rgba(181,137,0,0.45)", backgroundColor: PAPER, boxShadow: "0 12px 28px -18px rgba(0,43,54,0.4)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="prx-live absolute inline-flex h-full w-full rounded-full" style={{ backgroundColor: SOL.yellow, opacity: 0.6 }} />
          <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: SOL.yellow }} />
        </span>
        <p className="min-w-0 flex-1 text-[12px] leading-snug" style={{ color: SOL.base00 }}>
          <b style={{ color: SOL.base02 }}>2 notes not sent yet.</b> Only you can see them until you finish your review.
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Verdict">
        {VERDICTS.map((v) => {
          const on = verdict === v.key;
          return (
            <button
              key={v.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => { setVerdict(v.key); setDest("github"); }}
              className="prx-chip rounded-md border px-2.5 py-1 text-[11.5px]"
              style={{ borderColor: on && dest === "github" ? v.color : SOL.base2, color: on && dest === "github" ? v.color : SOL.base00, backgroundColor: on && dest === "github" ? `${v.color}14` : "transparent" }}
            >
              {v.label}
            </button>
          );
        })}
        <span className="mx-1 hidden h-4 w-px sm:inline-block" style={{ backgroundColor: SOL.base2 }} />
        <button
          type="button"
          onClick={() => setDest(dest === "session" ? "github" : "session")}
          aria-pressed={dest === "session"}
          className="prx-chip rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{ borderColor: dest === "session" ? SOL.cyan : SOL.base2, color: dest === "session" ? SOL.cyan : SOL.base00, backgroundColor: dest === "session" ? "rgba(42,161,152,0.08)" : "transparent" }}
        >
          Send to session
        </button>
      </div>
    </div>
  );
}
