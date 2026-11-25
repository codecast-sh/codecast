"use client";
// A person typed "ship" in a session whose change touches judged files (ct-100350): the thread lists those files, each
// with the session that wrote it, and one button. Its click approves exactly that list, as a press on Ship's confirm
// does (convex changeApprovals.recordPress), so the run the session starts needs no card for them.
import { useState } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { usePressApproval } from "../../../hooks/usePressApproval";
import { typedShip } from "../../../lib/ship/judgedEdits";
import "../../ship/ship.css";

type Msg = { _id?: string; role?: string; content?: string | null };

export function ShipApprovalPrompt({ conversationId, sessionTitle }: { conversationId: string; sessionTitle: string }) {
  // Only the id of the newest typed ship, so the thread's other messages never wake this.
  const shipId = useInboxStore((s) => typedShip(((s.messages as Record<string, Msg[]>)[conversationId] ?? [])));
  const [done, setDone] = useState<string | null>(null);
  const approval = usePressApproval(conversationId, !!shipId && done !== shipId);
  if (!shipId || done === shipId || !approval.files?.length) return null;
  return (
    <section className="shp-approve" data-ship-approve={shipId}>
      <header><b>Approve these judged files</b><span>they judge changes, so this click is the approval</span></header>
      <ul>{approval.files.map((f) => <li key={f}><code>{f}</code><span>{sessionTitle}</span></li>)}</ul>
      <button type="button" className="sj-btn" data-primary onClick={async () => { if (await approval.record()) setDone(shipId); }} data-ship-approve-go>Approve {approval.files.length === 1 ? "it" : `all ${approval.files.length}`}</button>
    </section>
  );
}
