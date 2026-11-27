// The ids of the priority cards the store holds. A priority card is its
// person's alone and is acted on only through the card (THE RULE on
// isPriorityCard): a surface that walks queue items by their session (the
// agent dock, an org role's asks) leaves these out. Signature-gated on the
// ids, so a card's ticks or answer re-render nothing here.
import { useMemo } from "react";
import { isPriorityCard } from "@codecast/shared/contracts/priorityCard";
import { useCollectionRows } from "./useCollectionRows";
import type { SessionDecisionItem } from "../store/inboxStore";

const cardWhere = (d: SessionDecisionItem) => isPriorityCard(d);
const cardSig = (d: SessionDecisionItem) => d._id;

export function usePriorityCardIds(): ReadonlySet<string> {
  const rows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: cardWhere, sig: cardSig });
  return useMemo(() => new Set(rows.map((d) => d._id)), [rows]);
}
