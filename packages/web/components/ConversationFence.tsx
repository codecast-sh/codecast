import { useMemo, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { ExamplePair } from "./decisions/ChangeCardView";
import { readConversationFence, type ConversationMessage } from "../lib/conversationFence";
import "./conversationFence.css";

/** How many of the thread's last messages show before "earlier" opens the rest. */
const SHOWN = 3;

function Bubble({ m }: { m: ConversationMessage }) {
  const [open, setOpen] = useState(false);
  const long = m.text.length > 280 || m.text.split("\n").length > 4;
  return (
    <div className={`cv-msg ${m.agent ? "is-agent" : ""}`}>
      <div className="cv-meta">
        <span className="cv-from">{m.from}</span>
        {m.at && <span>{m.at}</span>}
      </div>
      {long ? (
        <button type="button" className={`cv-bubble ${open ? "" : "is-clamped"}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {m.text}
        </button>
      ) : (
        <div className="cv-bubble">{m.text}</div>
      )}
    </div>
  );
}

/** The `conversation` fence: the thread as a back and forth, then the agent's reply before and with a change, side by side, what matters marked. */
export default function ConversationFence({ code }: { code: string }) {
  const read = useMemo(() => readConversationFence(code), [code]);
  const [all, setAll] = useState(false);
  if (!read.ok) return <CodeBlock code={code} language="json" />;
  const { spec } = read;
  const hidden = all ? 0 : Math.max(0, spec.thread.length - SHOWN);
  return (
    <div className="cv-fence change-card" data-conversation-fence>
      {spec.title && <div className="cv-title">{spec.title}</div>}
      {spec.thread.length > 0 && (
        <div className="cv-thread">
          {hidden > 0 && (
            <button type="button" className="cv-earlier" onClick={() => setAll(true)}>
              {hidden} earlier
            </button>
          )}
          {spec.thread.slice(hidden).map((m, i) => (
            <Bubble key={hidden + i} m={m} />
          ))}
        </div>
      )}
      <ExamplePair
        ex={{ input: "", before: spec.before, after: spec.after, note: spec.note }}
        beforeLabel="Before the change"
        afterLabel="With the change"
        marks={spec.mark}
      />
    </div>
  );
}
