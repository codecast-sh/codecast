"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { MessageSquare, ExternalLink, Users, Sparkles } from "lucide-react";
import { api as convexApi } from "@codecast/convex/convex/_generated/api";
import { ContextChatInput } from "../ContextChatInput";
import { useInboxStore, type SteeringItem } from "../../store/inboxStore";

type EntityType = "strategy" | "steering_item";

export function buildSteeringContext({
  type,
  entity,
  items,
  strategy,
  linkedExecution,
  relationships,
  narrative,
}: {
  type: EntityType;
  entity: any;
  items: SteeringItem[];
  strategy?: any;
  linkedExecution?: string[];
  relationships?: string[];
  narrative?: string;
}) {
  const byId = new Map(items.map((item) => [item._id, item]));
  const ancestors: SteeringItem[] = [];
  if (type === "steering_item") {
    let cursor = entity.parent_item_id ? byId.get(entity.parent_item_id) : undefined;
    while (cursor && ancestors.length < 20) {
      ancestors.unshift(cursor);
      cursor = cursor.parent_item_id ? byId.get(cursor.parent_item_id) : undefined;
    }
  }
  const children =
    type === "steering_item"
      ? items.filter((item) => item.parent_item_id === entity._id)
      : [];
  const entityNarrative = [
    narrative,
    entity.description,
    entity.success_criteria,
    entity.hypothesis,
    entity.resolution_summary,
    entity.intent,
    entity.rationale,
    entity.result_summary,
    entity.why_it_matters,
    entity.current_answer,
  ].filter(Boolean);
  return [
    "You are the team's Steering partner: help people reason deeply about strategic execution before suggesting structural changes.",
    "Be decisive rather than interrogative: ask at most one pivotal question in a response, and prefer a provisional synthesis the user can correct. Unresolved ambiguity belongs in Question items.",
    "Answer, synthesize, ask clarifying questions, trace uncertainty, and challenge inconsistencies as appropriate. Do not funnel every exchange into a mutation.",
    "Never mutate Strategy or Steering Items autonomously. If a structural change is warranted, propose an exact field-level diff with object ID, current value, proposed value, rationale, and execution impact; explicitly ask for human confirmation.",
    "Do not infer priorities, attention, progress, evidence, or health from observed work. Tasks and Plans remain separate execution primitives.",
    "Never create a Plan or Task as a substitute for Steering structure. Draft graph changes with `cast steering proposal create` (inspect `cast steering proposal-format` first), report the sp-* id verbatim, and apply only after the user explicitly approves that exact proposal using `cast steering proposal apply sp-* --yes`.",
    `Selected ${type === "strategy" ? "Strategy" : entity.kind}: ${entity.title} (${entity.short_id ?? entity._id}, status ${entity.status ?? "unknown"}).`,
    entityNarrative.length ? `Narrative:\n- ${entityNarrative.join("\n- ")}` : "Narrative: not yet written.",
    strategy && type !== "strategy"
      ? `Current Strategy: ${strategy.title} (${strategy.status}).`
      : "",
    ancestors.length
      ? `Ancestors:\n${ancestors.map((item) => `- ${item.kind}: ${item.title} [${item.status}]`).join("\n")}`
      : "Ancestors: none.",
    children.length
      ? `Children:\n${children.map((item) => `- ${item.kind}: ${item.title} [${item.status}]`).join("\n")}`
      : "Children: none.",
    linkedExecution?.length
      ? `Explicitly linked execution:\n${linkedExecution.map((line) => `- ${line}`).join("\n")}`
      : "Explicitly linked execution: none visible.",
    relationships?.length
      ? `Typed strategic relationships:\n${relationships.map((line) => `- ${line}`).join("\n")}`
      : "Typed strategic relationships: none visible.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function SteeringConversationPanel({
  entityType,
  entity,
  items,
  strategy,
  linkedExecution = [],
  relationships = [],
  narrative,
}: {
  entityType: EntityType;
  entity: any;
  items: SteeringItem[];
  strategy?: any;
  linkedExecution?: string[];
  relationships?: string[];
  narrative?: string;
}) {
  const conversations = useInboxStore((state) => state.conversations);
  const sessions = useInboxStore((state) => state.sessions);
  const visibleSidePanelId = useInboxStore((state) => state.sidePanelSessionId);
  const links = useQuery(
    (convexApi as any).conversationLinks.webListForEntity,
    { entity_type: entityType, entity_id: entity._id },
  ) as any[] | undefined;
  const context = useMemo(
    () =>
      buildSteeringContext({
        type: entityType,
        entity,
        items,
        strategy,
        linkedExecution,
        relationships,
        narrative,
      }),
    [entityType, entity, items, strategy, linkedExecution, relationships, narrative],
  );
  const related = (links ?? [])
    .map((link) => ({
      link,
      conversation:
        conversations[link.conversation_id] ?? sessions[link.conversation_id] ?? link.conversation,
    }))
    .filter((row) => row.conversation);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const effectiveConversationId = selectedConversationId === "__new__"
    ? null
    : selectedConversationId ?? (related.some(({ conversation }: any) => conversation._id === visibleSidePanelId) ? visibleSidePanelId : null);
  const selectedConversation = related.find(
    ({ conversation }: any) => conversation._id === effectiveConversationId,
  )?.conversation;
  const openConversation = (id: string) =>
    useInboxStore.setState({ sidePanelSessionId: id, sidePanelOpen: true });

  return (
    <section className="mt-8 border-t border-sol-border/30 pt-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-sol-cyan" />
            <h3 className="text-sm font-medium text-sol-text">
              Think with your Steering partner
            </h3>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-sol-text-dim">
            Reason from this object, its strategic lineage, children, and explicit
            execution links. The partner may challenge or draft a change; nothing
            consequential changes without your confirmation.
          </p>
        </div>
        <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-sol-text-dim">
          <Users className="h-3 w-3" /> shared context
        </span>
      </div>

      {links === undefined ? (
        <div className="mt-4 h-12 animate-pulse rounded-lg bg-sol-bg-highlight" />
      ) : related.length ? (
        <div className="mt-4 space-y-2">
          {related.map(({ link, conversation }: any) => (
            <button
              key={link._id}
              onClick={() => {
                setSelectedConversationId(conversation._id);
                openConversation(conversation._id);
              }}
              className={`group flex w-full items-center gap-3 rounded-lg border bg-sol-card px-3 py-3 text-left ${effectiveConversationId === conversation._id ? "border-sol-cyan/50" : "border-sol-border/35 hover:border-sol-cyan/30"}`}
            >
              <MessageSquare className="h-4 w-4 shrink-0 text-sol-cyan" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-sol-text">
                  {conversation.title || "Steering discussion"}
                </span>
                <span className="text-[10px] capitalize text-sol-text-dim">
                  {link.relationship} · {conversation.message_count ?? 0} messages
                </span>
              </span>
              <ExternalLink className="h-3.5 w-3.5 text-sol-text-dim group-hover:text-sol-cyan" />
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-xs text-sol-text-dim">
          No discussion yet. Start with a decision, uncertainty, or challenge—not
          a status update.
        </p>
      )}

      <div className="mt-4 overflow-hidden rounded-xl border border-sol-border/35 bg-sol-bg-alt/40">
        <div className="flex items-center justify-between border-b border-sol-border/25 px-4 py-2">
          <span className="text-[10px] text-sol-text-dim">
            {selectedConversation ? `Continue: ${selectedConversation.title || "selected discussion"}` : "New discussion"}
          </span>
          {selectedConversation && (
            <button type="button" onClick={() => setSelectedConversationId("__new__")} className="text-[10px] text-sol-cyan">
              Start new thread
            </button>
          )}
        </div>
        <ContextChatInput
          contextType={entityType}
          contextTitle={entity.title}
          linkedObjectId={entity._id}
          conversationId={selectedConversation?._id}
          getContextBody={() => context}
          placeholder={
            entityType === "strategy"
              ? "Challenge the argument, trace a belief, or propose a revision…"
              : `What should we understand or decide about this ${entity.kind}?`
          }
        />
        {selectedConversation && (
          <p className="px-4 pb-3 text-[10px] text-sol-text-dim">
            Messages will continue only in the discussion you explicitly selected.
          </p>
        )}
      </div>
    </section>
  );
}
