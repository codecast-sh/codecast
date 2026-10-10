"use client";

import Link from "next/link";
import { type CSSProperties, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { InstallTabs } from "@/components/install-tabs";
import { guideHref } from "../../documentation/guides/guides";
import { featureHref, featureDeepDives } from "../catalog";
import { CallScore } from "./CallScore";
import { ChannelDigest, CitationMessage, DeliveryTimeline, HuddleChat, ItemToTask, PeopleWall, SessionDigest, SnapFrame, TrackDiagram, WalkieBurst } from "./mocks";
import { C, Section } from "./parts";
import "./calls.css";
import { useStillMode } from "../kit";

const HERO_WAYS = [
  { where: "Huddle", note: "in a channel's header, or ring someone from a DM or their face" },
  { where: "Calls", note: "every huddle, live ones first, each with its summary and transcript" },
  { where: "Send to agent", note: "hands a call, or the lines you picked, to a session" },
];

const ASK: string[] = [
  "What did we agree on yesterday's call about the webhook retries?",
  "Turn the action items from this morning's huddle into tasks, each quoting who took it on.",
  "Summarize every call this week where billing came up.",
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
    a: <>No. A session room&apos;s agent hears the words live in batches while the huddle runs, and at the end it gets a short summary with a pointer to the full transcript. The words stay on the server until it asks.</>,
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
                Codecast huddles transcribe while they run, with the speaker&apos;s name on every line. When the huddle ends it gets a title, a summary and action items. Your agents can read it, cite the exact words, and turn what was agreed into tasks.
              </p>
            </div>
            <div className="cc-rise space-y-2" style={{ "--d": "0.28s" } as CSSProperties}>
              {HERO_WAYS.map((h) => (
                <div key={h.where} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg px-4 py-2.5" style={{ backgroundColor: "#fffaf0", border: `1px solid ${SOL.base2}` }}>
                  <span className="font-mono text-[13.5px] font-semibold" style={{ color: SOL.magenta }}>{h.where}</span>
                  <span className="text-[13px]" style={{ color: SOL.base01 }}>{h.note}</span>
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
            <p>A channel or DM gets a chat message with the transcript a click away. A huddle in a session&apos;s own room wakes that session&apos;s agent instead, with the summary and a pointer to the rest.</p>
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
        title="Every call has a page, and your agents can quote it"
        tone="paper"
        lede={
          <>
            <p>The <b>Calls</b> page lists every huddle and voice note you can open, live ones first, with a <b>with video</b> filter. A call&apos;s page holds the summary, the action items and the whole transcript under its speakers. Click a line, click another to extend the selection, and <b>Send to agent</b> hands the excerpt to a session with a note on what to do.</p>
            <p>Agents read calls the way you read the page. When one quotes a call, the quote shows the speaker and links to those lines on the call&apos;s page, and a mention of the call renders as a live pill with its title, length and speakers.</p>
          </>
        }
      >
        <div className="grid gap-6 lg:grid-cols-[1.05fr_1fr] lg:items-start">
          <div className="min-w-0">
            <div className="font-mono text-[12px] mb-3" style={{ color: SOL.base1 }}>ask in plain words</div>
            <ul className="space-y-2.5">
              {ASK.map((q) => (
                <li key={q} className="rounded-lg px-4 py-3 text-[14.5px] leading-[1.6]" style={{ backgroundColor: "#fffaf0", border: `1px solid ${SOL.base2}`, color: SOL.base02 }}>{q}</li>
              ))}
            </ul>
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
            <p>The generated action items are a draft. Ask an agent to turn them into tasks and it reads the summary, checks every item against the transcript (who committed, to what, by when, and whether anyone pushed back later), drops what was only floated and adds what the summary missed.</p>
            <p>Each surviving item becomes a task assigned to the person who took it on, with their line quoted in the description and the call linked. Tasks people agreed to reach the human board on their own.</p>
          </>
        }
      >
        <ItemToTask />
        <p className="mt-6 max-w-3xl text-[14px] leading-relaxed" style={{ color: SOL.base00 }}>
          For scripts and agents: the <C>/cast-from-call</C> skill runs this pass, and files each item as a task decided in a meeting.
        </p>
      </Section>

      <Section
        id="agents"
        n="05"
        title="Bring a session into the room"
        tone="paper"
        lede={
          <>
            <p>Start a huddle from a session&apos;s header, or click <b>+</b> in any huddle and pick <b>A new agent session</b> (<i>Hears the room and answers here</i>). One person is enough to start, because the agent is the second party. You can also point any huddle at another session, a doc or a linked Slack channel, live or once at the end.</p>
            <p>Words arrive each time the room goes quiet. A line that names the agent goes through at once, even mid-turn; the rest waits until its turn ends. When it needs to concentrate, the agent can ask for quiet for up to 30 minutes, and whatever was said meanwhile arrives together when the hold ends.</p>
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
            <p>Press <b>Record this huddle</b> and the huddle is filmed on the LiveKit server, with a red REC mark everywhere the call shows and a notice for everyone, guests included. Anyone in the call can stop it. Screen shares are kept as their own full resolution files, so code on a shared screen stays legible.</p>
            <p>On the call&apos;s page the video plays beside the transcript and stays in step with it. An agent can take a frame of any line or second to see what was on screen, and when it cites that moment in a message, the frame renders for anyone who can read the call.</p>
          </>
        }
      >
        <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-start">
          <SnapFrame />
          <ul className="space-y-4 text-[15px] leading-[1.7]" style={{ color: SOL.base01 }}>
            <li><b style={{ color: SOL.base02 }}>Click a line</b> to jump the video to that moment. The line being said lights up as it plays.</li>
            <li><b style={{ color: SOL.base02 }}>Back to the moment</b> returns to the playing line after you scroll away.</li>
            <li><b style={{ color: SOL.base02 }}>Link</b> copies a link to that second.</li>
            <li><b style={{ color: SOL.base02 }}>Screen shares</b> are kept at full resolution, and you can switch the view to them.</li>
          </ul>
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
          <h2 className="font-mono text-[26px] sm:text-[32px] font-bold tracking-tight" style={{ color: SOL.base3 }}>For scripts and agents</h2>
          <p className="mt-2 text-[15px]" style={{ color: SOL.base0 }}>
            Agents read calls through these commands, and you can script them too. <span className="font-mono">&lt;id&gt;</span> is a short id like cl-42, a full id, or a unique prefix. Every read takes <span className="font-mono">--json</span>.
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
                Install codecast, then have a team admin switch on <b>Calls</b> under Settings, Team, Features. The agents on every member&apos;s computer learn to read the team&apos;s calls.
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
