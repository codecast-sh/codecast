"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Box, Label, Sheet } from "../figureParts";

/**
 * Figures for the pull requests guide. The mirror loop is githubWebhooks.ts
 * and prCli.ts; wake rules and the 20s by 5 retry are prShepherd.ts; the
 * batch review is reviews.submitReviewWithNotes and deliverSubmittedReview.
 */

// ─── One writer: the inbound handler ───────────────────────────────────────

/** Acts go out to GitHub; only GitHub's webhook writes the row everyone reads. */
export function MirrorLoopFigure() {
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={290} label="The page, the CLI and agents act through prCli.ts to GitHub. GitHub answers with a webhook, which is verified, deduplicated and stored, and the inbound handler is the only writer of the pull request row that every surface reads">
        {(arrow) => (
          <>
            <Box x={20} y={36} w={200} h={56} title="page · CLI · agent" sub="act through prCli.ts" ink="blue" className="bj-pop" style={t(0.1)} />
            <Box x={560} y={100} w={180} h={70} title="GitHub" sub="the source of truth" ink="base02" bold={1.6} className="bj-pop" style={t(0.3)} />
            <Box x={290} y={196} w={210} h={56} title="/api/webhooks/github-app" sub="verify · dedupe by delivery id" ink="orange" className="bj-pop" style={t(1.5)} />
            <Box x={20} y={196} w={200} h={56} title="pull_requests row" sub="checks, reviews, threads" ink="green" bold={1.6} className="bj-pop" style={t(2.3)} />

            <path d="M223 58C420 58 560 60 640 96" pathLength={1} fill="none" stroke={SOL.blue} strokeWidth={1.6} markerEnd={arrow("blue")} className="bj-draw" style={t(0.6, 0.5)} />
            <Label x={410} y={50} lines={["comment, review, merge …"]} ink="blue" anchor="middle" className="bj-fade" style={t(0.8)} />

            <path d="M640 174C620 220 560 224 504 224" pathLength={1} fill="none" stroke={SOL.orange} strokeWidth={1.6} markerEnd={arrow("orange")} className="bj-draw" style={t(1.2, 0.4)} />
            <Label x={630} y={232} lines={["every act comes", "back as a webhook"]} ink="orange" className="bj-fade" style={t(1.4)} />

            <path d="M287 224H224" pathLength={1} fill="none" stroke={SOL.green} strokeWidth={1.8} markerEnd={arrow("green")} className="bj-draw" style={t(2.0, 0.3)} />
            <Label x={256} y={216} lines={["writes"]} ink="green" anchor="middle" weight={700} className="bj-fade" style={t(2.1)} />

            <path d="M120 193V96" pathLength={1} fill="none" stroke={SOL.green} strokeWidth={1.4} strokeDasharray="4 3" markerEnd={arrow("green")} className="bj-draw" style={t(2.6, 0.3)} />
            <Label x={128} y={144} lines={["every surface", "reads it"]} ink="green" className="bj-fade" style={t(2.8)} />

            {/* the outbound path never writes */}
            <g className="bj-fade" style={t(3.2)}>
              <path d="M300 92L250 180" stroke={SOL.red} strokeWidth={1.2} strokeDasharray="3 3" />
              <circle cx={275} cy={136} r={8} fill={SOL.base3} stroke={SOL.red} />
              <path d="M271 132l8 8M279 132l-8 8" stroke={SOL.red} strokeWidth={1.5} />
            </g>
            <Label x={292} y={128} lines={["the outbound side", "never writes the row"]} ink="red" className="bj-fade" style={t(3.3)} />

            <Label x={295} y={274} lines={["a comment codecast posted returns too, and is skipped by its GitHub id"]} ink="base1" size={10} className="bj-fade" style={t(3.7)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── What wakes the shepherd ───────────────────────────────────────────────

const EVENTS = [
  { text: "a check fails", wake: true },
  { text: "changes requested, or a review with a body", wake: true },
  { text: "a person comments on a line", wake: true },
  { text: "the branch stops merging cleanly", wake: true },
  { text: "the branch falls behind its base", wake: false, note: "fires pr_behind" },
  { text: "checks go green, new commits", wake: false },
  { text: "a bot or the author comments", wake: false },
];

const URGENCY = ["conflict", "failed check", "changes requested"];

/** Which events wake the owning session, and what the wake carries when it lands. */
export function ShepherdWakeFigure() {
  return (
    <Stage>
      <div className="grid grid-cols-1 *:min-w-0 md:grid-cols-[1.15fr_1fr]">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="Events on the pull request" sub="Only the ones that need the author's hands wake the session." color={SOL.orange} />
          <div className="m-4 space-y-1 font-mono text-[12px]">
            {EVENTS.map((e, i) => (
              <div key={e.text} className="flex items-center gap-2 bj-rise" style={t(0.1 + i * 0.14)}>
                <span className="w-12 shrink-0 text-center text-[10.5px] rounded px-1 py-0.5" style={e.wake ? { backgroundColor: `${SOL.orange}22`, color: SOL.orange, fontWeight: 700 } : { color: SOL.base1, border: `1px solid ${SOL.base2}` }}>
                  {e.wake ? "wake" : "quiet"}
                </span>
                <span style={{ color: e.wake ? SOL.base02 : SOL.base1 }}>{e.text}</span>
                {e.note && <span className="text-[10.5px]" style={{ color: SOL.base1 }}>· {e.note}</span>}
              </div>
            ))}
          </div>
        </div>
        <div>
          <PanelHead title="When the session is busy" sub="The wake waits instead of interrupting a run." color={SOL.blue} />
          <div className="m-4 font-mono text-[12px]">
            <div className="flex items-center gap-1.5">
              {[0, 1, 2, 3, 4].map((k) => (
                <div key={k} className="flex items-center gap-1.5 bj-pop" style={t(1.3 + k * 0.25)}>
                  <span className="inline-block w-3 h-3 rounded-full" style={{ border: `1.5px solid ${SOL.blue}`, backgroundColor: k === 4 ? SOL.blue : "transparent" }} />
                  {k < 4 && <span className="text-[10px]" style={{ color: SOL.base1 }}>20s</span>}
                </div>
              ))}
            </div>
            <div className="text-[11px] mt-1.5 bj-fade" style={{ ...t(2.4), color: SOL.base01 }}>up to 5 retries, collecting every reason that arrives</div>
            <div className="mt-4 text-[11px] bj-fade" style={{ ...t(2.7), color: SOL.base1 }}>the prompt is rebuilt from the row now, and leads with</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {URGENCY.map((u, i) => (
                <span key={u} className="flex items-center gap-1.5 bj-pop" style={t(2.9 + i * 0.2)}>
                  <span className="px-2 py-0.5 rounded-md" style={{ backgroundColor: `${SOL.red}${["26", "18", "0e"][i]}`, color: SOL.red }}>{u}</span>
                  {i < URGENCY.length - 1 && <span style={{ color: SOL.base1 }}>›</span>}
                </span>
              ))}
            </div>
            <div className="mt-4 text-[11px] leading-relaxed bj-fade" style={{ ...t(3.6), color: SOL.base01 }}>
              Fix it all in one pass, push to the same branch, reply to each point. Never merge unless a human asked.
            </div>
          </div>
        </div>
      </div>
    </Stage>
  );
}

// ─── A review as one batch ─────────────────────────────────────────────────

const NOTES = ["src/retry.ts:42", "src/retry.ts:88", "src/queue.ts:17"];

/** Held notes stay private until one verdict sends them all; the owner hears it once. */
export function ReviewBatchFigure() {
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={270} label="Notes are held privately, then cast pr review sends them as one GitHub review under the reviewer's own account. GitHub's comment ids are stamped back, the owning session gets one message, and the webhook for the same review stands down">
        {(arrow) => (
          <>
            {NOTES.map((n, i) => (
              <g key={n} className="bj-rise" style={t(0.1 + i * 0.25)}>
                <rect x={20 + i * 6} y={60 + i * 34} width={170} height={28} rx={6} fill={SOL.base3} stroke={SOL.base1} strokeDasharray="3 2" />
                <text x={32 + i * 6} y={78 + i * 34} fontSize="10.5" fill={SOL.base02}>--hold {n}</text>
              </g>
            ))}
            <Label x={20} y={40} lines={["held: yours alone, nothing sent"]} ink="base01" className="bj-fade" style={t(0.2)} />

            <Box x={250} y={96} w={190} h={56} title="cast pr review" sub="--request-changes -b …" ink="violet" bold={1.6} className="bj-pop" style={t(1.0)} />
            <path d="M205 124H246" pathLength={1} stroke={SOL.base1} strokeWidth={1.4} fill="none" markerEnd={arrow()} className="bj-draw" style={t(0.9, 0.2)} />

            <Box x={540} y={30} w={200} h={54} title="GitHub: one review" sub="under your own account" ink="base02" className="bj-pop" style={t(1.6)} />
            <path d="M443 112Q500 60 536 58" pathLength={1} stroke={SOL.violet} strokeWidth={1.6} fill="none" markerEnd={arrow("violet")} className="bj-draw" style={t(1.3, 0.3)} />
            <path d="M560 87Q520 130 446 128" pathLength={1} stroke={SOL.base1} strokeWidth={1.2} strokeDasharray="3 3" fill="none" markerEnd={arrow()} className="bj-draw" style={t(2.0, 0.3)} />
            <Label x={572} y={104} lines={["comment ids", "stamped back"]} ink="base1" size={10} className="bj-fade" style={t(2.2)} />

            <Box x={540} y={168} w={200} h={54} title="owning session" sub="one message: verdict + notes" ink="green" className="bj-pop" style={t(2.6)} />
            <path d="M443 140Q500 196 536 195" pathLength={1} stroke={SOL.green} strokeWidth={1.6} fill="none" markerEnd={arrow("green")} className="bj-draw" style={t(2.4, 0.3)} />

            <g className="bj-fade" style={t(3.2)}>
              <path d="M700 87V164" stroke={SOL.base1} strokeWidth={1.2} strokeDasharray="2 4" />
              <circle cx={700} cy={126} r={8} fill={SOL.base3} stroke={SOL.base1} />
              <path d="M696 122l8 8M704 122l-8 8" stroke={SOL.base1} strokeWidth={1.4} />
            </g>
            <Label x={714} y={252} lines={["its webhook waits 20s, finds the", "delivery stamp, and stands down"]} ink="base1" size={10} anchor="end" className="bj-fade" style={t(3.4)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}
