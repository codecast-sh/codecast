// Every open approval, oldest first: the things the assistant is holding
// until the person says yes.
import { useMemo } from "react";
import { ApprovalCard } from "../../../components/simple/ApprovalCard";
import { conversationTitle } from "../../../components/simple/lane";
import { useLaneData } from "../../../components/simple/useLane";

export default function SimpleApprovals() {
  const { conversations, approvals } = useLaneData();
  const titles = useMemo(() => new Map(conversations.map((c) => [String(c._id), conversationTitle(c)])), [conversations]);
  return (
    <main>
      <h1 className="sl-page-title sl-rise">Approvals</h1>
      <p className="sl-lede sl-rise" style={{ ["--i" as any]: 1 }}>
        Nothing goes out or changes until you say so. Oldest first.
      </p>
      {approvals.length === 0 ? (
        <div className="sl-empty sl-rise" style={{ ["--i" as any]: 2 }}>
          You're all caught up. When I need your OK, it shows up here.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.9rem" }}>
          {approvals.map((d, n) => (
            <ApprovalCard key={d._id} decision={d} from={titles.get(String(d.conversation_id))} index={n + 2} />
          ))}
        </div>
      )}
    </main>
  );
}
