"use client";

import Link from "next/link";
import { type CSSProperties, type ReactNode } from "react";
import { SOL, Terminal, Cmd } from "../../blog/blogChrome";
import { InstallTabs } from "@/components/install-tabs";
import { guideHref } from "../../documentation/guides/guides";
import { featureHref, featureDeepDives } from "../catalog";
import { CallScore } from "./CallScore";
import { ChannelDigest, CitationMessage, DeliveryTimeline, HuddleChat, ItemToTask, PeopleWall, SessionDigest, SnapFrame, TrackDiagram, WalkieBurst } from "./mocks";
import { C, Section } from "./parts";
import "./calls.css";
import { useStillMode } from "../kit";

/** Dimmed terminal text. */
function D({ children }: { children: ReactNode }) {
  return <span style={{ color: SOL.base01 }}>{children}</span>;
}
function K({ children, c = SOL.cyan }: { children: ReactNode; c?: string }) {
  return <span style={{ color: c }}>{children}</span>;
}

const HERO_COMMANDS = [
  { cmd: "cast calls", note: "every call, live first" },
  { cmd: "cast call cl-42 --transcript", note: "who said what" },
  { cmd: "cast call hold 10m", note: "a fed agent asks for quiet" },
];

const REFERENCE: { cmd: string; does: string }[] = [
  { cmd: "cast calls", does: "Calls across your teams, live ones first. Add -n 50 for more history, or --video for only the calls with video." },
  { cmd: "cast call <id>", does: "Title, length, speakers, summary, action items, linked sessions, and what was filmed." },
  { cmd: "cast call <id> --transcript", does: "The whole transcript under its speakers, each line labeled with the reference that cites it." },
  { cmd: "cast call <id> 15:25", does: "Only lines 15 to 25 (15-25 and 15 work too)." },
  { cmd: "cast call cl-42@12:34", does: "The lines being said at 12 minutes 34 seconds, with that line marked." },
  { cmd: "cast call <id> --json", does: "The same as data: segments with seq, speaker_id, speaker_name, text and times. Says whether the call is shared, never its link." },
  { cmd: "cast call hold <3m|90s|1h|off>", does: "From a session a live huddle feeds: hold the room's words for a stretch of work. Up to 30 minutes per ask." },
  { cmd: "cast call snap cl-42:15", does: "A PNG of the recorded call at the moment line 15 was said. Also @12:34, line ranges, --screen, --composite, --crop, --tiles 2x2. Needs ffmpeg." },
];

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "How does it know who said what?",
    a: <>It never guesses. One client in the room is the scribe, and it sends each person&apos;s audio track to speech recognition on its own connection. A track belongs to one participant, so every segment is stamped with that participant. There is no diarization step to get wrong.</>,
  },
  {
    q: "Is every huddle transcribed?",
    a: <>Yes, unless someone in the room turns it off. Transcription is a switch on the room itself, and anyone seated can flip it either way. Turning it off ends the run, and the digest of what was already said still posts. Video is different: it records only when someone presses Record, and everyone in the room is told.</>,
  },
  {
    q: "Who can read a call?",
    a: <>You can read a call you took part in, and a call whose room you may enter: the people a DM is between, the members of a channel, the people who can open a session. Guests see and hear the call they were let into, and nothing else: not the team, its sessions or the transcript.</>,
  },
  {
    q: "Does the agent get the whole transcript dumped into its context?",
    a: <>No. A session room&apos;s agent hears the words live in batches while the huddle runs, and at the end it gets a short <C>&lt;huddle-summary&gt;</C> with a pointer to <C>cast call &lt;id&gt; --transcript</C>. The words stay on the server until it asks.</>,
  },
  {
    q: "What if the call is short or the summary fails?",
    a: <>A huddle under 40 words gets no generated summary; its digest is the words themselves. If a summary cannot be generated, the call is marked failed and the transcript is still readable.</>,
  },
  {
    q: "What do I need to turn it on?",
    a: <>Calls are a team feature, off until a team admin turns them on, like team chat. The deployment also needs a LiveKit server for the media. Without either, every call control stays hidden.</>,
  },
];

const RELATED = ["memory", "decisions", "agents", "triggers"];

export default function CallsPage() {
  const isStatic = useStillMode();
  return (
    <main className="cc-root" data-static={isStatic ? "" : undefined} style={{ backgroundColor: SOL.base3 }}>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(180deg, transparent 0 46px, rgba(211,54,130,0.07) 46px 47px), radial-gradient(ellipse 70% 60% at 85% 0%, rgba(211,54,130,0.10), transparent 70%)",
          }}
        />
        <div className="relative max-w-6xl mx-auto px-5 sm:px-8 pt-14 sm:pt-20 pb-16 sm:pb-24">
          <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-end">
            <div className="lg:col-span-2">
              <Link href="/features" className="cc-fade inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12.5px] font-mono" style={{ backgroundColor: "rgba(211,54,130,0.1)", color: SOL.magenta }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOL.magenta }} />
                Features / Calls
              </Link>
              <h1 className="cc-rise mt-5 font-mono text-[27px] min-[400px]:text-[30px] sm:text-[44px] lg:text-[56px] font-bold leading-[1.05] tracking-tight [text-wrap:balance]" style={{ color: SOL.base03, "--d": "0.08s" } as CSSProperties}>
                Decide it out loud.
                <br />
                <span style={{ color: SOL.magenta }}>The agents can quote&nbsp;you.</span>
              </h1>
            </div>
            <div>
              <p className="cc-rise max-w-xl text-[17px] leading-[1.65]" style={{ color: SOL.base01, "--d": "0.18s" } as CSSProperties}>
                Codecast huddles transcribe while they run, with the speaker&apos;s name on every line. When the huddle ends it gets a title, a summary and action items. Any session can read it with <C>cast call</C>, cite the exact words, and turn what was agreed into tasks.
              </p>
            </div>
            <div className="cc-rise space-y-2" style={{ "--d": "0.28s" } as CSSProperties}>
              {HERO_COMMANDS.map((h) => (
                <div key={h.cmd} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg px-4 py-2.5 font-mono" style={{ backgroundColor: SOL.base03 }}>
                  <span className="text-[13.5px]"><span style={{ color: SOL.green }}>$ </span><span style={{ color: SOL.base2 }}>{h.cmd}</span></span>
                  <span className="text-[11.5px]" style={{ color: SOL.base01 }}># {h.note}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="cc-rise mt-12" style={{ "--d": "0.4s" } as CSSProperties}>
            <CallScore />
            <p className="mt-3 text-center text-[12.5px] font-mono" style={{ color: SOL.base1 }}>
              The first minute of a six minute huddle. One lane per voice, the session that heard it live, and the digest it left behind.
            </p>
          </div>
        </div>
      </section>

      <Section
        id="speakers"
        n="01"
        title="Every line knows who said it"
        tone="paper"
        lede={
          <>
            <p>Most meeting tools record one mixed stream and guess the speakers afterwards. Codecast never mixes. The scribe, one client in the room, holds each person&apos;s audio track and streams it to speech recognition on its own connection.</p>
            <p>A track belongs to one person, so the attribution is structural. If the scribe&apos;s laptop closes, another client in the room adopts the same run, and the old one lets go so no word lands twice.</p>
          </>
        }
      >
        <TrackDiagram />
      </Section>

      <Section
        id="digest"
        n="02"
        title="The digest lands where the huddle was held"
        lede={
          <>
            <p>Every finished huddle with any words leaves one digest: the title, the length, the speakers, the summary and the action items. Where it goes depends on the room.</p>
            <p>A channel or DM gets a chat message with the transcript a click away. A huddle in a session&apos;s own room wakes that session&apos;s agent instead, with the summary and the command to read the rest.</p>
          </>
        }
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <ChannelDigest />
          <SessionDigest />
        </div>
      </Section>

      <Section
        id="read"
        n="03"
        title="Any session can read it, and cite the exact words"
        tone="paper"
        lede={
          <>
            <p>A call is an object like a task or a session, with a short id. Every transcript line is printed with the reference that cites it, so an agent quoting the call names the line and the person.</p>
            <p><C>cl-42</C> in a message renders as a live pill with the call&apos;s title, length and speakers. <C>cl-42:3-4</C> on its own line embeds those lines with their speakers. Both link to the call page with the lines selected.</p>
          </>
        }
      >
        <div className="grid gap-6 lg:grid-cols-[1.05fr_1fr] lg:items-start">
          <div className="-my-6 min-w-0">
            <Terminal label="any session" wrap>
              <Cmd>cast calls</Cmd>
              <K c={SOL.base01}>○ </K><K>cl-42</K> 14:02 <D>6m</D>  <span style={{ color: SOL.base2 }}>Webhook retry rollout</span>{"\n"}
              <D>   Maya, Theo, Priya</D>{"\n"}
              <K c={SOL.base01}>○ </K><K>cl-41</K> 11:30 <D>14m</D>  <span style={{ color: SOL.base2 }}>Billing page review</span>{"\n"}
              <D>   Maya, Sam</D>{"\n\n"}
              <Cmd>cast call cl-42 3:4</Cmd>
              <span style={{ color: SOL.base2 }}>Webhook retry rollout</span> <D>lines 3-4</D>{"\n"}
              <K>Priya</K>{"\n"}
              <D>  cl-42:3 0:19</D> Can we move to exponential with jitter before Friday?{"\n"}
              <K>Theo</K>{"\n"}
              <D>  cl-42:4 0:24</D> Yes, I&apos;ll take it. I&apos;ll add a dead letter queue while I&apos;m in there.{"\n\n"}
              <D>Embed these words in a message: </D>cl-42:3-4<D> on its own line</D>
            </Terminal>
          </div>
          <CitationMessage />
        </div>
      </Section>

      <Section
        id="tasks"
        n="04"
        title="Action items become tasks that quote the call"
        lede={
          <>
            <p>The generated action items are a draft. The <C>/cast-from-call</C> skill reads the summary, checks every item against the transcript (who committed, to what, by when, and whether anyone pushed back later), drops what was only floated and adds what the summary missed.</p>
            <p>Each surviving item is filed with <C>cast task create --from-meeting</C>, assigned to the person who took it on, with their line quoted in the description. Tasks people agreed to reach the human board on their own.</p>
          </>
        }
      >
        <ItemToTask />
        <div className="mt-8 max-w-3xl">
          <Terminal label="what the skill files, per item" wrap>
            <Cmd>{`cast task create "Exponential backoff with jitter for webhook retries" --from-meeting --assignee theo -p high -d - <<'DESC'`}</Cmd>
            <span style={{ color: SOL.base2 }}>Agreed on the call Webhook retry rollout (cl-42).</span>{"\n"}
            <span style={{ color: SOL.base2 }}>Theo: &quot;Yes, I&apos;ll take it. I&apos;ll add a dead letter queue while I&apos;m in there.&quot;</span>{"\n"}
            <span style={{ color: SOL.base2 }}>Due: before Friday</span>{"\n"}
            <D>DESC</D>{"\n"}
            <K c={SOL.green}>ok</K> Created <K>ct-812</K>: Exponential backoff with jitter for webhook retries
          </Terminal>
        </div>
      </Section>

      <Section
        id="agents"
        n="05"
        title="Bring a session into the room"
        tone="paper"
        lede={
          <>
            <p>A huddle in a session&apos;s own room feeds that session live. One person is enough to start, because the agent is the second party. You can also point any huddle at another session, a doc or a linked Slack channel, live or once at the end.</p>
            <p>Words arrive each time the room goes quiet, on the same path as <C>cast send</C>. A line that names the agent goes through at once, even mid-turn; the rest waits until its turn ends. When it needs to concentrate, the agent runs <C>cast call hold 10m</C>, and whatever was said meanwhile arrives together when the hold ends.</p>
          </>
        }
      >
        <DeliveryTimeline />
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr] lg:items-start">
          <HuddleChat />
          <div className="space-y-4 text-[15px] leading-[1.7]" style={{ color: SOL.base01 }}>
            <p>A fed session takes part in the huddle&apos;s text chat. The reply it ends a turn with appears there as its own line, cut at 1800 characters with a link to the session, and a line a person types there is relayed in.</p>
            <p>On codecast.sh the agent also gets a face: a video participant that says its replies out loud and is marked as an agent on every surface, so nobody takes it for a person. A deployment without a face provider configured keeps agents in the chat.</p>
            <p>Delivery acts as the person who added the route, stamped by the server, so a scribe cannot write into sessions only someone else can reach. A guest naming the agent never cuts into its turn; their words arrive as context.</p>
          </div>
        </div>
      </Section>

      <Section
        id="video"
        n="06"
        title="What was on screen when they said that"
        lede={
          <>
            <p>Press Record and the huddle is filmed on the LiveKit server, with a red REC mark everywhere the call shows and a notice for everyone, guests included. Anyone in the call can stop it. Screen shares are kept as their own full resolution files, so code on a shared screen stays legible.</p>
            <p><C>cast call snap</C> turns a reference into a picture an agent can open. <C>cl-42@12:34</C> alone on a line in a message renders as that same frame for anyone who can read the call.</p>
          </>
        }
      >
        <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-start">
          <SnapFrame />
          <div className="-my-6 min-w-0">
            <Terminal label="frames of a recorded call" wrap>
              <Cmd>cast call snap cl-42:4</Cmd>
              <D># the moment line 4 was said (0:25)</D>{"\n"}
              <Cmd>cast call snap cl-42@12:34</Cmd>
              <D># 12m34s in (also 754s, 12m34s, 1:02:03)</D>{"\n"}
              <Cmd>cast call snap cl-42:15-25</Cmd>
              <D># frames where the screen changed, 8 by default</D>{"\n"}
              <Cmd>cast call snap cl-42:4 --crop top-left</Cmd>
              <D># part of the frame at full size</D>{"\n"}
              <Cmd>cast call snap cl-42:4 --screen</Cmd>
              <D># the shared screen only, or refuse</D>{"\n"}
              <Cmd>cast call snap cl-42</Cmd>
              <D># right now, while it records</D>
            </Terminal>
          </div>
        </div>
      </Section>

      <Section
        id="presence"
        n="07"
        title="Faces, presence and walkie"
        tone="paper"
        lede={
          <>
            <p>The people wall draws the whole team at once, each face sized by how present that person is: active, idle, away or offline, from app check-ins and recent keyboard or mouse input. Click a face for Talk, Ring and Message.</p>
            <p>Walkie is push to talk into a DM. The listener hears it live if they are at their desk, everyone else gets the voice recording, and the words show in the DM while they are still being said. It stays one way until somebody presses Join live.</p>
          </>
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <PeopleWall />
          <WalkieBurst />
        </div>
      </Section>

      {/* Safety and limits */}
      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-24">
        <h2 className="font-mono text-[26px] sm:text-[32px] font-bold leading-[1.15] tracking-tight" style={{ color: SOL.base03 }}>The rules the room keeps</h2>
        <div className="mt-8 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Seats are leases", "A client heartbeats every 15 seconds and a seat older than 45 is ignored, so a closed laptop leaves the room on its own. Everyone joins muted."],
            ["Rooms can lock", "An occupied room admits teammates the way a meeting room does. Lock it and a teammate has to knock; anyone inside rings them in."],
            ["Guests come in on a link", "No account needed. They wait at the door until someone admits them, are told up front when the call is transcribed or recorded, and are marked as a guest on every tile and line."],
            ["Recording is never silent", "Only a press of Record starts it. Everyone is told, a beep sounds, and it stops when no teammate is left. The video is readable by whoever may open the room's calls."],
            ["Private calls stay private", "A frame of a private call goes to a scratch directory cleared after a day. --share makes a public image only when you ask, and deleting the recording deletes it."],
            ["The server checks every mutation", "Room rules are enforced in every call mutation and when a media token is minted, because the media server trusts that token."],
          ].map(([t, b]) => (
            <div key={t} className="pl-4" style={{ borderLeft: `2px solid rgba(211,54,130,0.35)` }}>
              <div className="font-mono text-[15px] font-bold" style={{ color: SOL.base02 }}>{t}</div>
              <p className="mt-1.5 text-[14.5px] leading-[1.65]" style={{ color: SOL.base01 }}>{b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Command reference */}
      <section style={{ backgroundColor: SOL.base03 }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-20">
          <h2 className="font-mono text-[26px] sm:text-[32px] font-bold tracking-tight" style={{ color: SOL.base3 }}>Command reference</h2>
          <p className="mt-2 text-[15px]" style={{ color: SOL.base0 }}>
            <span className="font-mono">&lt;id&gt;</span> is a short id like cl-42, a full id, or a unique prefix. Every read takes <span className="font-mono">--json</span>.
          </p>
          <dl className="mt-8 divide-y" style={{ borderColor: "#0b4a5a" }}>
            {REFERENCE.map((r) => (
              <div key={r.cmd} className="grid gap-1 py-3.5 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] md:gap-8" style={{ borderTop: "1px solid #0b4a5a" }}>
                <dt className="font-mono text-[13.5px] break-words" style={{ color: SOL.base2 }}><span style={{ color: SOL.green }}>$ </span>{r.cmd}</dt>
                <dd className="text-[14px] leading-[1.6]" style={{ color: SOL.base0 }}>{r.does}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-4xl mx-auto px-5 sm:px-8 py-16 sm:py-24">
        <h2 className="font-mono text-[26px] sm:text-[32px] font-bold tracking-tight" style={{ color: SOL.base03 }}>Questions and limits</h2>
        <div className="mt-8 space-y-3">
          {FAQ.map((f, i) => (
            <details key={f.q} className="group rounded-xl px-5 py-4" style={{ backgroundColor: "#fffaf0", border: `1px solid ${SOL.base2}` }} open={i === 0}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-mono text-[15px] font-semibold" style={{ color: SOL.base02 }}>
                {f.q}
                <span className="shrink-0 transition-transform group-open:rotate-45 text-[20px] leading-none" style={{ color: SOL.magenta }}>+</span>
              </summary>
              <div className="mt-3 text-[15px] leading-[1.7]" style={{ color: SOL.base01 }}>{f.a}</div>
            </details>
          ))}
        </div>
      </section>

      {/* Related and CTA */}
      <section style={{ backgroundColor: SOL.base2 + "80" }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-20">
          <h2 className="font-mono text-[22px] font-bold" style={{ color: SOL.base03 }}>Works with</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {featureDeepDives(RELATED).map((f) => {
              return (
                <Link key={f.slug} href={featureHref(f.slug)} className="cc-lift block rounded-xl px-4 py-4" style={{ backgroundColor: "#fffaf0", border: `1px solid ${SOL.base2}` }}>
                  <div className="font-mono text-[14px] font-bold" style={{ color: f.color }}>{f.name}</div>
                  <div className="mt-1 text-[13px] leading-snug" style={{ color: SOL.base01 }}>{f.title.replace(/^[^:]+:\s*/, "").replace(/^./, (c) => c.toUpperCase())}</div>
                </Link>
              );
            })}
          </div>

          <div className="mt-16 grid gap-8 lg:grid-cols-[1fr_1fr] lg:items-center">
            <div>
              <h2 className="font-mono text-[28px] sm:text-[34px] font-bold leading-tight tracking-tight" style={{ color: SOL.base03 }}>Start a huddle. Read it from any session.</h2>
              <p className="mt-3 text-[16px] leading-[1.65]" style={{ color: SOL.base01 }}>
                Install the CLI, then have a team admin turn calls on. The calls snippet teaches your agents <C>cast calls</C> and <C>cast call</C>.
              </p>
              <Link href={guideHref("calls")} className="mt-4 inline-block font-mono text-[14px] underline underline-offset-4" style={{ color: SOL.magenta }}>Read the calls guide</Link>
            </div>
            <InstallTabs location="feature-calls" />
          </div>
        </div>
      </section>
    </main>
  );
}
