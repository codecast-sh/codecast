import type { JointPart } from "@codecast/shared/contracts/jointMessage";
import { MessageMarkdown } from "./markdown";

// A joint turn's body: each person's words under their own name, in the
// order the agent reads them.
export function JointParts({ parts, collapsed }: { parts: JointPart[]; collapsed: boolean }) {
  if (collapsed) {
    return (
      <span className="whitespace-pre-wrap">
        {parts.map((p, i) => <span key={i}><b className="text-sol-blue/80 font-medium">{p.from}:</b> {p.body}{i < parts.length - 1 ? "  " : ""}</span>)}
      </span>
    );
  }
  return (
    <div data-cc-joint-turn className="not-prose flex flex-col gap-3">
      {parts.map((p, i) => (
        <div key={i} className={i > 0 ? "pt-3 border-t border-dashed border-sol-blue/20" : ""}>
          <div className="text-[11px] font-medium text-sol-blue/80 mb-1">{p.from}</div>
          <div className="prose prose-invert prose-sm max-w-none"><MessageMarkdown content={p.body} userText /></div>
        </div>
      ))}
    </div>
  );
}
