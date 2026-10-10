"use client";
// The Chat view (line-workspace.md LW1, LW4), ported from the Copilot
// prototype: a conversation with the line. It opens with one sentence of the
// line's own numbers and the graph; the person asks in their words, and the
// session that answers for the line (the project lead's, else one started for
// the chat, convex lineChat.ts) replies in markdown whose ```line blocks draw
// live widgets. Those widgets read this workspace's model and open steps and
// runs in place (LineFenceScopeProvider). The rail is the line as a spine:
// a press opens the step's drawer, and the open step or run rides along with
// the next question, so the answer is about what the person is looking at.
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { LineViewProps } from "./types";
import type { LineModel, LineRunModel } from "../../../../lib/line/lineModel";
import { answererWords, greetingWords, suggestedQuestions, type LineChatEntry } from "../../../../lib/line/lineChat";
import { waitingWords } from "../../../../lib/decisionDiscussion";
import { sendLineChat, useLineChat } from "../../../../hooks/useLineChat";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { MarkdownRenderer } from "../../../tools/MarkdownRenderer";
import { KeyCap } from "../../../KeyCap";
import { LineFenceScopeProvider, LineGraphWidget, useLineNav, type LineFenceScope } from "../../widgets";
import "./chat/chat.css";

/** The chat's mark: an agent's dot, a script's point, a person's diamond. */
function Mark() {
  return (
    <span className="lwc-avatar" aria-hidden>
      <svg viewBox="0 0 16 16"><circle cx="4" cy="8" r="2.4" className="lwc-m-agent" /><circle cx="8.5" cy="8" r="1.4" className="lwc-m-script" /><rect x="11" y="6" width="3.6" height="3.6" rx=".6" transform="rotate(45 12.8 7.8)" className="lwc-m-person" /></svg>
    </span>
  );
}

const timeWords = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** What the person has open: `wire` names ids the answering session can look
 *  up, `words` is what the composer shows. Null with nothing open. */
function focusOf(model: LineModel, step: string | null, run: LineRunModel | null): { wire: string; words: string } | null {
  const s = step ? model.steps[step] : null;
  const onCase = run?.caseRef ? ` on ${run.caseRef}` : "";
  const wire = [s && `step "${s.id}" (${s.label})`, run && `run ${run.id}${onCase}`].filter(Boolean).join(" and ");
  const words = [s?.label, run && `the run${onCase}`].filter(Boolean).join(" and ");
  return wire ? { wire, words } : null;
}

export function ChatView({ model, workspace, selection, select }: LineViewProps) {
  const projectId = workspace.project?._id ?? null;
  const nav = useLineNav();
  const scope = useMemo<LineFenceScope | null>(() => (projectId ? { projectId, model, nav, now: workspace.now } : null), [projectId, model, nav, workspace.now]);
  const { ready, owner, thread } = useLineChat(projectId);
  const run = useMemo(() => (selection.run ? model.runs.find((r) => r.id === selection.run) ?? null : null), [model.runs, selection.run]);
  const suggestions = useMemo(() => suggestedQuestions(model, selection.step), [model, selection.step]);
  const who = answererWords(owner, ready);
  const focus = useMemo(() => focusOf(model, selection.step, run), [model, selection.step, run]);

  const [text, setText] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const opened = useRef(false);

  const send = useCallback((words: string) => {
    const said = words.trim();
    if (!said || !projectId) return;
    setText("");
    setRefused(null);
    pinned.current = true;
    // A refused send comes back to the box with the reason, never left as "Sending…".
    void sendLineChat(projectId, said, model.graphKey, focus?.wire ?? null).then((why) => {
      if (!why) return;
      setRefused(why);
      setText((now) => now || said);
    });
  }, [projectId, model.graphKey, focus]);

  const onSubmit = (e: FormEvent) => { e.preventDefault(); send(text); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); }
    if (e.key === "Escape") { e.preventDefault(); box.current?.blur(); }
  };

  // The box grows with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  // "/" puts the cursor in the box from anywhere in the view.
  useEffect(() => {
    const onSlash = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || keyBelongsElsewhere(e.target)) return;
      e.preventDefault();
      box.current?.focus();
    };
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, []);

  // New words and new replies follow the bottom while the reader is there;
  // someone reading back up is left where they are.
  const shape = thread.map((e) => `${e.client_id}:${e.state}`).join("|");
  useLayoutEffect(() => {
    const el = scroller.current;
    // An empty thread opens at its greeting; a conversation opens at its end.
    if (el && pinned.current && thread.length) el.scrollTo({ top: el.scrollHeight, behavior: opened.current ? "smooth" : "auto" });
    opened.current = true;
  }, [shape, thread.length]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const placeholder = selection.step && model.steps[selection.step]
    ? `Ask about ${model.steps[selection.step].label}, or say what it should do differently`
    : "Ask the line, or tell a step what to do differently";

  return (
    <LineFenceScopeProvider scope={scope}>
      <div className="lwc" data-line-chat>
        <div className="lwc-main">
          <div className="lwc-thread" ref={scroller} onScroll={onScroll}>
            <div className="lwc-col">
              <BotTurn>
                <p className="lwc-say">{greetingWords(model)}</p>
                <LineCard model={model} run={run} step={selection.step} onRun={(r) => select({ run: r?.id ?? null }, r?.caseId ?? null)} />
              </BotTurn>
              {thread.map((e) => <Exchange key={e.client_id} entry={e} answerer={who.name} />)}
            </div>
          </div>

          <div className="lwc-dock">
            {suggestions.length > 0 && (
              <div className="lwc-suggest" data-line-chat-suggest>
                {suggestions.map((q) => <button key={q} type="button" className="lwc-sug" onClick={() => send(q)} disabled={!projectId}>{q}</button>)}
              </div>
            )}
            <form className="lwc-composer" onSubmit={onSubmit}>
              {focus && <div className="lwc-focus" title="Sent with your message, so the answer is about what you have open">Looking at {focus.words}</div>}
              <textarea
                ref={box}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                placeholder={placeholder}
                aria-label="Message the line"
                data-line-chat-input
              />
              <button type="submit" className="lwc-send" aria-label="Send" disabled={!text.trim() || !projectId}>
                <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden><path d="M4 10h11M10 4.5 15.5 10 10 15.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </form>
            <div className="lwc-foot">
              {refused
                ? <span className="lwc-refused" data-line-chat-refused>Not sent: {refused}</span>
                : <span className="lwc-goes" title={who.why || undefined}>Goes to <b>{who.name}</b>{owner && <Link href={`/conversation/${owner.conversation_id}`} className="lwc-open" title="Its whole conversation">open<ArrowUpRight className="h-3 w-3" /></Link>}</span>}
              <span className="lwc-keys"><KeyCap size="xs">return</KeyCap> send <KeyCap size="xs">shift</KeyCap><KeyCap size="xs">return</KeyCap> new line <KeyCap size="xs">/</KeyCap> focus</span>
            </div>
          </div>
        </div>
        <Spine model={model} current={selection.step} onOpen={(id) => select({ step: id })} />
      </div>
    </LineFenceScopeProvider>
  );
}

function BotTurn({ children, at }: { children: React.ReactNode; at?: number }) {
  return (
    <div className="lwc-turn" title={at ? timeWords(at) : undefined}>
      <div className="lwc-bot"><Mark /><div className="lwc-bot-body">{children}</div></div>
    </div>
  );
}

/** One ask and what came back: the reply rendered with its widgets, else where the words are. */
const Exchange = memo(function Exchange({ entry, answerer }: { entry: LineChatEntry; answerer: string }) {
  return (
    <Fragment>
      <div className="lwc-turn" data-me title={timeWords(entry.at)}>
        <div className="lwc-bubble" data-state={entry.state}>{entry.text}</div>
      </div>
      {entry.reply ? (
        <BotTurn at={entry.reply.at}>
          <div className="lwc-md" data-line-chat-reply><MarkdownRenderer content={entry.reply.text} /></div>
        </BotTurn>
      ) : (
        <BotTurn>
          <div className="lwc-wait" data-state={entry.state} data-line-chat-waiting>
            <span className="lwc-dots" aria-hidden><i /><i /><i /></span>
            {waitingWords(entry.state, answerer)}
          </div>
        </BotTurn>
      )}
    </Fragment>
  );
});

/** The opening object: the graph, a run to trace on it, and who does what. */
const LineCard = memo(function LineCard({ model, run, step, onRun }: { model: LineModel; run: LineRunModel | null; step: string | null; onRun: (run: LineRunModel | null) => void }) {
  const runs = useMemo(() => [...model.runs].sort((a, b) => b.at - a.at).slice(0, 80), [model.runs]);
  const counts = useMemo(() => {
    const c = { agent: 0, script: 0, person: 0 };
    for (const id of model.order) {
      const k = model.steps[id]?.kind;
      if (k === "agent" || k === "script" || k === "person") c[k]++;
    }
    return c;
  }, [model]);
  return (
    <div className="lw-obj lwc-linecard" data-line-chat-graph>
      <div className="lw-obj-head">
        <span className="lw-obj-title">The line</span>
        <span className="lw-spacer" />
        {runs.length > 0 && (
          <select className="lwc-runpick" value={run?.id ?? ""} onChange={(e) => onRun(runs.find((r) => r.id === e.target.value) ?? null)} aria-label="Trace a run on the graph">
            <option value="">Trace a run…</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{`${r.caseRef ?? r.caseTitle.slice(0, 40)} · ${r.outcome.text}`}</option>)}
          </select>
        )}
      </div>
      <div className="lwc-graph"><LineGraphWidget model={model} run={run} selectedStep={step} compact bare /></div>
      <div className="lwc-legend">
        {counts.agent > 0 && <span className="lw-kind" data-kind="agent">{counts.agent} {counts.agent === 1 ? "agent" : "agents"}, a prompt each</span>}
        {counts.script > 0 && <span className="lw-kind" data-kind="script">{counts.script} {counts.script === 1 ? "script" : "scripts"}, code</span>}
        {counts.person > 0 && <span className="lw-kind" data-kind="person">{counts.person} {counts.person === 1 ? "gate" : "gates"}, you</span>}
        {run && <span className="lwc-legend-note">{run.outcome.text}</span>}
      </div>
    </div>
  );
});

/** The line as a spine, a half at a time: a press opens the step. */
const Spine = memo(function Spine({ model, current, onOpen }: { model: LineModel; current: string | null; onOpen: (id: string) => void }) {
  const halves = useMemo(() => model.graph.halves.map((h) => ({
    key: h.key,
    label: h.label,
    steps: model.order.map((id) => model.steps[id]).filter((s) => s && s.half === h.key && s.kind !== "end"),
  })).filter((h) => h.steps.length), [model]);
  return (
    <aside className="lwc-rail" aria-label="Steps" data-line-chat-rail>
      <div className="lwc-rail-head"><span>Steps</span><small>open one</small></div>
      {halves.map((h) => (
        <div key={h.key} className="lwc-half">
          <div className="lwc-half-name">{h.label}</div>
          <div className="lwc-spine">
            {h.steps.map((s) => (
              <button key={s.id} type="button" className="lwc-rstep" data-kind={s.kind} aria-current={current === s.id ? "step" : undefined} onClick={() => onOpen(s.id)} title={s.purpose} data-line-chat-step={s.id}>
                <span className="lwc-glyph" />
                <span className="lwc-nm">{s.label}</span>
                {s.kind !== "script" && s.decisions.length > 0 && <span className="lwc-cnt">{s.decisions.length}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
});
