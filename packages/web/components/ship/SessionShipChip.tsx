"use client";
// An inbox card's word for where its session's work is on its way to
// production (lib/ship/sessionShip): in review, your call, fixing, waiting to
// deploy, live in dp-N, deploy failed. A deploy's state opens that deploy.
import Link from "next/link";
import { entityRoute } from "@codecast/shared/entities";
import { useSessionShip } from "../../hooks/useSessionShipState";
import "./ship.css";

export function SessionShipChip({ conversationId }: { conversationId: string }) {
  const ship = useSessionShip(conversationId);
  if (!ship) return null;
  const body = <><i aria-hidden />{ship.words}</>;
  const href = ship.deploy ? entityRoute("deploy", ship.deploy) : null;
  return href
    ? <Link href={href} className="ssc" data-tone={ship.tone} onClick={(e) => e.stopPropagation()} data-session-ship={ship.words}>{body}</Link>
    : <span className="ssc" data-tone={ship.tone} data-session-ship={ship.words}>{body}</span>;
}
