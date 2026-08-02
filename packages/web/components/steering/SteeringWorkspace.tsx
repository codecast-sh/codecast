"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api as convexApi } from "@codecast/convex/convex/_generated/api";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Flag,
  HelpCircle,
  Layers3,
  MessageCircle,
  Plus,
  Search,
  Sparkles,
  Target,
  UserRound,
} from "lucide-react";
import { useInboxStore, type SteeringItem } from "../../store/inboxStore";
import { useWorkspaceArgs } from "../../hooks/useWorkspaceArgs";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { ContextChatInput } from "../ContextChatInput";
import { SteeringConversationPanel } from "./SteeringConversationPanel";

export type SteeringView = "overview" | "map" | "strategy" | "my-work";
type Kind = SteeringItem["kind"];
const KINDS: Array<{
  kind: Kind;
  label: string;
  plural: string;
  icon: any;
  prompt: string;
}> = [
  {
    kind: "objective",
    label: "Objective",
    plural: "Objectives",
    icon: Target,
    prompt: "What change should become true?",
  },
  {
    kind: "bet",
    label: "Bet",
    plural: "Bets",
    icon: CircleDot,
    prompt: "What do we believe, and why?",
  },
  {
    kind: "initiative",
    label: "Initiative",
    plural: "Initiatives",
    icon: Flag,
    prompt: "What bounded effort are we undertaking?",
  },
  {
    kind: "question",
    label: "Question",
    plural: "Questions",
    icon: HelpCircle,
    prompt: "What must we understand?",
  },
];
const kindMeta = (kind: Kind) => KINDS.find((k) => k.kind === kind)!;
const priorityWeight: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

function useInActiveWorkspace() {
  const workspace = useWorkspaceArgs();
  return (row: { team_id?: string }) =>
    workspace !== "skip" &&
    (workspace.workspace === "team"
      ? row.team_id === workspace.team_id
      : workspace.workspace === "personal"
        ? !row.team_id
        : true);
}
const lifecycleByKind: Record<Kind, string[]> = {
  objective: ["draft", "active", "paused", "achieved", "dropped", "archived"],
  bet: [
    "draft",
    "active",
    "supported",
    "weakened",
    "invalidated",
    "closed",
    "dropped",
    "archived",
  ],
  initiative: ["draft", "active", "paused", "completed", "dropped", "archived"],
  question: ["open", "investigating", "resolved", "dropped", "archived"],
};

function KindMark({
  item,
  compact = false,
}: {
  item: SteeringItem;
  compact?: boolean;
}) {
  const meta = kindMeta(item.kind);
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${compact ? "text-[10px]" : "text-xs"} text-sol-text-muted`}
    >
      <Icon className="w-3.5 h-3.5 text-sol-cyan" />
      {meta.label}
    </span>
  );
}

function CreateItem({
  parentId,
  onClose,
}: {
  parentId?: string;
  onClose: () => void;
}) {
  const create = useInboxStore((s) => s.createSteeringItem);
  const [kind, setKind] = useState<Kind>("objective");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError("");
    try {
      await create({
        kind,
        title: title.trim(),
        parent_item_id: parentId,
      });
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create item",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-sol-cyan/25 bg-sol-card p-4 shadow-sm space-y-3"
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
        {KINDS.map((k) => (
          <button
            type="button"
            key={k.kind}
            onClick={() => setKind(k.kind)}
            className={`px-2 py-2 rounded-md text-xs text-left ${kind === k.kind ? "bg-sol-cyan/12 text-sol-cyan" : "bg-sol-bg-alt text-sol-text-muted hover:text-sol-text"}`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="text-[11px] text-sol-text-dim">
          {kindMeta(kind).prompt}
        </span>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 w-full rounded-md border border-sol-border bg-sol-bg px-3 py-2 text-sm text-sol-text outline-none focus:border-sol-cyan"
          placeholder={`${kindMeta(kind).label} title`}
        />
      </label>
      {error && (
        <p role="alert" className="text-xs text-sol-red">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-sol-text-muted"
        >
          Cancel
        </button>
        <button
          disabled={busy || !title.trim()}
          className="px-3 py-1.5 rounded-md bg-sol-cyan text-sol-bg text-xs font-medium disabled:opacity-40"
        >
          Create
        </button>
      </div>
    </form>
  );
}

function PortfolioConversation({ items }: { items: SteeringItem[] }) {
  const context = [
    "You are entering the team's Steering operating room.",
    "Help the user reason about strategic execution: clarify intended change, surface assumptions and uncertainty, connect explicit execution, and challenge incoherence.",
    "Be a decisive thought partner, not a discovery questionnaire. Ask at most one pivotal question per response. After one or two substantive exchanges, offer a provisional Objective/Bet/Initiative/Question graph and invite correction. If the user says there is enough information, draft immediately and preserve remaining ambiguity as Question items.",
    "Do not invent relationships, priorities, progress, or evidence. Do not mutate anything without showing the exact proposed change and receiving explicit confirmation.",
    "Never create Plans or Tasks as a substitute for Steering structure. Plans and Tasks are separate execution primitives and may be created only after the user explicitly asks to translate confirmed Initiatives into execution.",
    "To draft durable structure, run `cast steering proposal-format`, write the JSON operations to a temporary file, then run `cast steering proposal create --title \"…\" --summary \"…\" --operations-file <file>`. Report the resulting sp-* id verbatim so it renders as a review widget. A proposal does not mutate the graph. After the user explicitly approves that exact proposal, run `cast steering proposal apply sp-* --yes` and report every returned st-*/si-* id verbatim.",
    items.length
      ? `Visible portfolio items:\n${items.map((item) => `- ${item.kind}: ${item.title} [${item.status}]${item.parent_item_id ? `, parent ${item.parent_item_id}` : ""}`).join("\n")}`
      : "The portfolio is empty. Begin from the user's natural language, form a provisional view quickly, and do not force them to resolve every uncertainty before drafting.",
  ].join("\n\n");
  return (
    <div className="overflow-hidden rounded-2xl border border-sol-cyan/25 bg-sol-card shadow-sm">
      <div className="flex gap-3 border-b border-sol-border/30 px-5 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sol-cyan/12 text-sol-cyan">
          <Sparkles className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xs font-medium text-sol-text">Think with Steering</p>
          <p className="mt-1 text-sm leading-6 text-sol-text-muted">
            {items.length
              ? "Challenge the portfolio, trace an uncertainty, or work through a decision. The agent sees only the explicit portfolio context below."
              : "Start wherever the truth is messiest. Your agent will help clarify the intended change before proposing structure."}
          </p>
          <p className="mt-1 text-[10px] text-sol-text-dim">Sending starts a new Steering discussion and opens it beside this room.</p>
        </div>
      </div>
      <div className="px-3 pt-3">
        <ContextChatInput
          contextType="steering_portfolio"
          contextTitle="Steering portfolio"
          getContextBody={() => context}
          placeholder={items.length ? "What should we reconsider?" : "What change are you trying to make true?"}
        />
      </div>
    </div>
  );
}

function PendingProposalShelf({ focusId }: { focusId?: string | null }) {
  const workspace = useWorkspaceArgs();
  const proposalArgs = workspace === "skip" ? "skip" : { status: "proposed", ...workspace };
  const { data: proposals } = useQueryNoThrow((convexApi as any).steeringProposals.webList, proposalArgs) as { data: any[] | undefined };
  const apply = useMutation((convexApi as any).steeringProposals.webApply);
  const dismiss = useMutation((convexApi as any).steeringProposals.webDismiss);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const target = focusId && proposals?.find((proposal) => proposal._id === focusId || proposal.short_id === focusId);
    if (!target) return;
    const frame = requestAnimationFrame(() => document.getElementById(`proposal-${target.short_id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [focusId, proposals]);
  if (!proposals?.length) return null;
  return (
    <section className="mt-5 space-y-3" aria-label="Pending Steering proposals">
      {proposals.map((proposal) => {
        const operations = proposal.operations ?? [];
        return (
          <article id={`proposal-${proposal.short_id}`} key={proposal._id} className={`rounded-2xl border bg-sol-cyan/[0.035] p-5 ${focusId === proposal._id || focusId === proposal.short_id ? "border-sol-cyan ring-1 ring-sol-cyan/30" : "border-sol-cyan/25"}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-sol-cyan"><Sparkles className="h-3.5 w-3.5" /> Proposed change · {proposal.short_id}</div>
                <h3 className="mt-2 text-base font-medium text-sol-text">{proposal.title}</h3>
                {proposal.summary && <p className="mt-1 text-xs leading-5 text-sol-text-muted">{proposal.summary}</p>}
              </div>
              <span className="rounded-full border border-sol-border/40 px-2 py-1 text-[10px] text-sol-text-dim">{operations.length} exact changes</span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {operations.map((op: any) => (
                <div key={op.key} className="rounded-xl border border-sol-border/35 bg-sol-card p-3 text-[11px]">
                  <p className="font-medium capitalize text-sol-cyan">{op.op.replaceAll("_", " ")}{op.kind ? ` · ${op.kind}` : ""}</p>
                  <p className="mt-1 font-mono text-[10px] text-sol-text-dim">ref: {op.key}</p>
                  {op.title && <p className="mt-1 text-sm leading-5 text-sol-text">{op.title}</p>}
                  <div className="mt-2 space-y-1">
                    {Object.entries(op).filter(([key]) => !["op", "key", "kind", "title"].includes(key)).map(([key, value]) => (
                      <p key={key} className="break-words text-sol-text-dim"><span className="text-sol-text-muted">{key.replaceAll("_", " ")}:</span> {typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}</p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {error && <p role="alert" className="mt-3 text-xs text-sol-red">{error}</p>}
            <div className="mt-4 flex justify-end gap-3">
              {proposal.conversation_id && <button onClick={() => useInboxStore.setState({ sidePanelSessionId: proposal.conversation_id, sidePanelOpen: true })} className="mr-auto text-xs text-sol-cyan">Open source discussion</button>}
              <button disabled={!!busy} onClick={async () => { setBusy(proposal._id); setError(""); try { await dismiss({ id: proposal._id }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not dismiss"); } finally { setBusy(null); } }} className="text-xs text-sol-text-dim">Dismiss</button>
              <button disabled={!!busy} onClick={async () => { setBusy(proposal._id); setError(""); try { await apply({ id: proposal._id }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not apply"); } finally { setBusy(null); } }} className="rounded-full bg-sol-cyan px-3 py-1.5 text-xs font-medium text-sol-bg disabled:opacity-50">{busy === proposal._id ? "Applying…" : "Apply proposal"}</button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function FirstRunRoom({ proposalId }: { proposalId?: string | null }) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-16">
      <div className="mb-8 flex items-center gap-2 text-xs text-sol-cyan">
        <Sparkles className="h-4 w-4" />
        Strategic operating room
      </div>
      <h2 className="max-w-3xl text-3xl font-semibold leading-tight text-sol-text sm:text-4xl">
        Start with the situation, not a schema.
      </h2>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-sol-text-muted">
        Think with an agent about the change, the uncertainty, and the work already in motion. Structure emerges only when it helps the reasoning.
      </p>
      <div className="mt-10"><PortfolioConversation items={[]} /><PendingProposalShelf focusId={proposalId} /></div>
      <p className="mt-5 text-center text-[11px] text-sol-text-dim">
        Conversation begins without creating portfolio objects. Any proposed change remains yours to confirm.
      </p>
    </div>
  );
}

function TreeNode({
  item,
  childrenByParent,
  depth,
  openItem,
}: {
  item: SteeringItem;
  childrenByParent: Map<string, SteeringItem[]>;
  depth: number;
  openItem: (id: string) => void;
}) {
  const children = childrenByParent.get(item._id) ?? [];
  const [expanded, setExpanded] = useState(depth < 2);
  return (
    <div>
      <div
        className="group flex items-center gap-1.5 rounded-md hover:bg-sol-bg-highlight/70"
        style={{ paddingLeft: `${Math.min(depth, 8) * 18}px` }}
      >
        <button
          aria-label={expanded ? "Collapse children" : "Expand children"}
          disabled={!children.length}
          onClick={() => setExpanded((v) => !v)}
          className="p-1 text-sol-text-dim disabled:opacity-0"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          onClick={() => openItem(item._id)}
          className="flex-1 min-w-0 py-2 pr-2 text-left"
        >
          <div className="flex items-center gap-2">
            <KindMark item={item} />
            <span className="truncate text-sm text-sol-text">{item.title}</span>
            {item.priority !== "none" && (
              <span className="ml-auto text-[10px] text-sol-text-dim capitalize">
                {item.priority}
              </span>
            )}
          </div>
        </button>
      </div>
      {expanded &&
        children.map((child) => (
          <TreeNode
            key={child._id}
            item={child}
            childrenByParent={childrenByParent}
            depth={depth + 1}
            openItem={openItem}
          />
        ))}
    </div>
  );
}

function DetailTextField({
  label,
  field,
  value,
  multiline = false,
  onCommit,
}: {
  label: string;
  field: string;
  value?: string;
  multiline?: boolean;
  onCommit: (field: string, value: any) => void;
}) {
  return (
    <label className="block text-xs text-sol-text-dim">
      {label}
      {multiline ? (
        <textarea
          defaultValue={value ?? ""}
          onBlur={(e) => onCommit(field, e.target.value || null)}
          rows={3}
          className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
        />
      ) : (
        <input
          defaultValue={value ?? ""}
          onBlur={(e) => onCommit(field, e.target.value || null)}
          className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
        />
      )}
    </label>
  );
}

function ItemDetail({
  item,
  items,
  onBack,
}: {
  item: SteeringItem;
  items: SteeringItem[];
  onBack: () => void;
}) {
  const inActiveWorkspace = useInActiveWorkspace();
  const updateMutation = useMutation(
    (convexApi as any).steeringItems.webUpdate,
  );
  const update = async (id: string, fields: Record<string, any>) =>
    await updateMutation({ id, ...fields });
  const me = useInboxStore((s) => s.currentUser);
  const remove = useInboxStore((s) => s.deleteSteeringItem);
  const link = useInboxStore((s) => s.linkEntities);
  const unlink = useInboxStore((s) => s.unlinkEntities);
  const tasks = useInboxStore((s) => s.tasks);
  const plans = useInboxStore((s) => s.plans);
  const strategies = useInboxStore((s) => s.strategies);
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? "");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [target, setTarget] = useState("");
  const [linkType, setLinkType] = useState("relates");
  const reorder = useMutation((convexApi as any).steeringItems.webReorder);
  const links = useQuery((convexApi as any).objectLinks.webListForEntity, {
    entity_type: "steering_item",
    entity_id: item._id,
  }) as any;
  const children = items.filter((i) => i.parent_item_id === item._id);
  const parent = items.find((i) => i._id === item.parent_item_id);
  const descendants = new Set<string>();
  const pending = [item._id];
  while (pending.length) {
    const id = pending.pop()!;
    for (const child of items.filter((i) => i.parent_item_id === id)) {
      descendants.add(child._id);
      pending.push(child._id);
    }
  }
  const parentOptions = items.filter(
    (i) => i._id !== item._id && !descendants.has(i._id),
  );
  const siblings = items.filter(
    (i) => i.parent_item_id === item.parent_item_id,
  );
  const siblingIndex = siblings.findIndex((i) => i._id === item._id);
  const move = async (delta: -1 | 1) => {
    const other = siblings[siblingIndex + delta];
    if (!other) return;
    try {
      setError("");
      await reorder({ id: item._id, before_id: other._id });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not reorder item",
      );
    }
  };
  const linkedEntities = [
    ...items
      .filter((i) => i._id !== item._id)
      .map((i) => ({
        type: "steering_item",
        id: i._id,
        label: `${kindMeta(i.kind).label}: ${i.title}`,
      })),
    ...Object.values(tasks)
      .filter((row) => inActiveWorkspace(row as any))
      .map((t: any) => ({
        type: "task",
        id: t._id,
        label: `Task: ${t.title}`,
      })),
    ...Object.values(plans)
      .filter((row) => inActiveWorkspace(row as any))
      .map((p: any) => ({
        type: "plan",
        id: p._id,
        label: `Plan: ${p.title}`,
      })),
    ...Object.values(strategies)
      .filter((row) => inActiveWorkspace(row as any))
      .map((strategy: any) => ({
        type: "strategy",
        id: strategy._id,
        label: `Strategy: ${strategy.title}`,
      })),
  ];
  const entityLabel = (type: string, id: string) =>
    linkedEntities.find((e) => e.type === type && e.id === id)?.label ??
    `${type.replace("_", " ")} ${id}`;
  const [selectedTargetType, ...selectedTargetParts] = target.split(":");
  const selectedTargetId = selectedTargetParts.join(":");
  const selectedTargetItem = items.find(
    (candidate) => candidate._id === selectedTargetId,
  );
  const availableLinkTypes =
    !target || selectedTargetType === "strategy"
      ? ["relates"]
      : ["task", "plan"].includes(selectedTargetType)
        ? ["executes", "investigates", "relates"]
        : [
            ...(item.kind === "initiative" &&
            selectedTargetItem?.kind === "objective"
              ? ["advances"]
              : []),
            ...((["initiative", "question"] as string[]).includes(item.kind) &&
            selectedTargetItem?.kind === "bet"
              ? ["tests"]
              : []),
            ...(item.kind === "question" &&
            selectedTargetItem?.kind === "initiative"
              ? ["blocks"]
              : []),
            ...(item.kind === "question" && selectedTargetItem?.kind === "bet"
              ? ["supports", "challenges"]
              : []),
            "relates",
          ];
  const setField = async (field: string, value: any) => {
    try {
      setError("");
      await update(item._id, { [field]: value });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `Could not update ${field.replaceAll("_", " ")}`,
      );
    }
  };
  const save = async () => {
    try {
      setError("");
      await update(item._id, {
        title: title.trim(),
        description: description.trim() || null,
      });
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save item");
    }
  };
  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-sol-text-muted hover:text-sol-text mb-5"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to map
      </button>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_280px] gap-6">
        <section className="min-w-0">
          <KindMark item={item} />
          {editing ? (
            <div className="mt-3 space-y-3">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-transparent border-b border-sol-cyan text-2xl font-semibold text-sol-text outline-none"
              />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                className="w-full rounded-lg border border-sol-border bg-sol-card p-3 text-sm text-sol-text outline-none focus:border-sol-cyan"
              />
              <div className="flex gap-2">
                <button
                  onClick={save}
                  className="px-3 py-1.5 bg-sol-cyan text-sol-bg rounded text-xs"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="text-xs text-sol-text-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-sol-text">
                {item.title}
              </h2>
              <p className="mt-3 text-sm leading-6 text-sol-text-muted whitespace-pre-wrap">
                {item.description || kindMeta(item.kind).prompt}
              </p>
              <button
                onClick={() => setEditing(true)}
                className="mt-3 text-xs text-sol-cyan"
              >
                Edit intent and inquiry
              </button>
            </>
          )}
          <SteeringConversationPanel
            entityType="steering_item"
            entity={item}
            items={items}
            strategy={Object.values(strategies)
              .filter((row) => inActiveWorkspace(row as any))
              .sort(
                (a: any, b: any) =>
                  Number(b.status === "active") - Number(a.status === "active") ||
                  b.updated_at - a.updated_at,
              )[0]}
            linkedExecution={(links ? [...links.incoming, ...links.outgoing] : [])
              .filter((row: any) =>
                [row.from_type, row.to_type].some((type) =>
                  ["task", "plan"].includes(type),
                ),
              )
              .map((row: any) =>
                `${row.link_type}: ${entityLabel(
                  row.from_type === "steering_item" ? row.to_type : row.from_type,
                  row.from_type === "steering_item" ? row.to_id : row.from_id,
                )}`,
              )}
            relationships={(links ? [...links.incoming, ...links.outgoing] : [])
              .filter((row: any) =>
                ![row.from_type, row.to_type].some((type) =>
                  ["task", "plan"].includes(type),
                ),
              )
              .map((row: any) => {
                const outgoing = row.from_type === "steering_item" && row.from_id === item._id;
                return `${outgoing ? "outgoing" : "incoming"} ${row.link_type}: ${entityLabel(
                  outgoing ? row.to_type : row.from_type,
                  outgoing ? row.to_id : row.from_id,
                )}`;
              })}
          />
          <div className="mt-8 border-t border-sol-border/30 pt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-sol-text-dim">
                Children
              </h3>
              <button
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1 text-xs text-sol-cyan"
              >
                <Plus className="w-3.5 h-3.5" />
                Add child
              </button>
            </div>
            {adding && (
              <div className="mt-3">
                <CreateItem
                  parentId={item._id}
                  onClose={() => setAdding(false)}
                />
              </div>
            )}
            <div className="mt-3 space-y-1">
              {children.length ? (
                children.map((c) => (
                  <button
                    key={c._id}
                    onClick={() => router.push(`/steering/map?id=${c._id}`)}
                    className="w-full flex items-center gap-3 p-3 rounded-lg bg-sol-card border border-sol-border/30 text-left hover:border-sol-cyan/30"
                  >
                    <KindMark item={c} />
                    <span className="text-sm text-sol-text truncate">
                      {c.title}
                    </span>
                  </button>
                ))
              ) : (
                <p className="text-xs text-sol-text-dim">
                  No nested items yet.
                </p>
              )}
            </div>
          </div>
          <div className="mt-8 border-t border-sol-border/30 pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-sol-text-dim">
              Relationships and linked execution
            </h3>
            <div className="mt-3 space-y-2">
              {links === undefined ? (
                <p className="text-xs text-sol-text-dim">
                  Loading relationships…
                </p>
              ) : (
                [
                  ...links.outgoing.map((edge: any) => ({
                    ...edge,
                    direction: "out",
                    otherType: edge.to_type,
                    otherId: edge.to_id,
                  })),
                  ...links.incoming.map((edge: any) => ({
                    ...edge,
                    direction: "in",
                    otherType: edge.from_type,
                    otherId: edge.from_id,
                  })),
                ].map((edge: any) => (
                  <div
                    key={edge._id}
                    className="flex items-center gap-2 rounded-md border border-sol-border/30 bg-sol-card p-2.5 text-xs"
                  >
                    <span className="text-sol-text-dim">
                      {edge.direction === "out"
                        ? edge.link_type
                        : `${edge.link_type} this`}
                    </span>
                    <a
                      href={
                        edge.otherType === "steering_item"
                          ? `/steering/map?id=${edge.otherId}`
                          : edge.otherType === "task"
                            ? `/tasks?id=${edge.otherId}`
                            : edge.otherType === "strategy"
                              ? "/steering/strategy"
                              : `/plans/${edge.otherId}`
                      }
                      className="flex-1 text-sol-cyan truncate"
                    >
                      {entityLabel(edge.otherType, edge.otherId)}
                    </a>
                    <button
                      onClick={async () => {
                        try {
                          await unlink(edge._id);
                        } catch (cause) {
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "Could not remove link",
                          );
                        }
                      }}
                      className="text-sol-red"
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="mt-3 grid sm:grid-cols-[120px_minmax(0,1fr)_auto] gap-2">
              <select
                value={linkType}
                onChange={(e) => setLinkType(e.target.value)}
                className="rounded border border-sol-border bg-sol-card px-2 py-2 text-xs text-sol-text"
              >
                {availableLinkTypes.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
              <select
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setLinkType("relates");
                }}
                className="rounded border border-sol-border bg-sol-card px-2 py-2 text-xs text-sol-text"
              >
                <option value="">Choose an item, task, or plan…</option>
                {linkedEntities.map((entity) => (
                  <option
                    key={`${entity.type}:${entity.id}`}
                    value={`${entity.type}:${entity.id}`}
                  >
                    {entity.label}
                  </option>
                ))}
              </select>
              <button
                disabled={!target}
                onClick={async () => {
                  const [to_type, ...idParts] = target.split(":");
                  try {
                    setError("");
                    const targetId = idParts.join(":");
                    const executionDirection =
                      ["executes", "investigates"].includes(linkType) &&
                      ["task", "plan"].includes(to_type);
                    await link(
                      executionDirection
                        ? {
                            from_type: to_type,
                            from_id: targetId,
                            link_type: linkType,
                            to_type: "steering_item",
                            to_id: item._id,
                          }
                        : {
                            from_type: "steering_item",
                            from_id: item._id,
                            link_type: linkType,
                            to_type,
                            to_id: targetId,
                          },
                    );
                    setTarget("");
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "That relationship is not valid",
                    );
                  }
                }}
                className="rounded bg-sol-cyan px-3 py-2 text-xs text-sol-bg disabled:opacity-40"
              >
                Add link
              </button>
            </div>
          </div>
        </section>
        <aside className="lg:border-l lg:border-sol-border/30 lg:pl-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-sol-text-dim">
            Operating state
          </h3>
          <div className="mt-3 space-y-3 text-xs">
            <label className="block text-sol-text-dim">
              Lifecycle
              <select
                value={item.status}
                onChange={(e) => setField("status", e.target.value)}
                className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
              >
                {lifecycleByKind[item.kind].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
            <label className="block text-sol-text-dim">
              Priority
              <select
                value={item.priority}
                onChange={(e) => setField("priority", e.target.value)}
                className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
              >
                {["urgent", "high", "medium", "low", "none"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="block text-sol-text-dim">
              Target date
              <input
                type="date"
                defaultValue={
                  item.target_date
                    ? new Date(item.target_date).toISOString().slice(0, 10)
                    : ""
                }
                onBlur={(e) =>
                  setField(
                    "target_date",
                    e.target.value
                      ? new Date(`${e.target.value}T12:00:00`).getTime()
                      : null,
                  )
                }
                className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
              />
            </label>
            <label className="block text-sol-text-dim">
              Review date
              <input
                type="date"
                defaultValue={
                  item.review_at
                    ? new Date(item.review_at).toISOString().slice(0, 10)
                    : ""
                }
                onBlur={(e) =>
                  setField(
                    "review_at",
                    e.target.value
                      ? new Date(`${e.target.value}T12:00:00`).getTime()
                      : null,
                  )
                }
                className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
              />
            </label>
            <label className="block text-sol-text-dim">
              Started date
              <input
                type="date"
                defaultValue={
                  item.started_at
                    ? new Date(item.started_at).toISOString().slice(0, 10)
                    : ""
                }
                onBlur={(e) =>
                  setField(
                    "started_at",
                    e.target.value
                      ? new Date(`${e.target.value}T12:00:00`).getTime()
                      : null,
                  )
                }
                className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
              />
            </label>
            <label className="block text-sol-text-dim">
              Completed date
              <input
                type="date"
                defaultValue={
                  item.completed_at
                    ? new Date(item.completed_at).toISOString().slice(0, 10)
                    : ""
                }
                onBlur={(e) =>
                  setField(
                    "completed_at",
                    e.target.value
                      ? new Date(`${e.target.value}T12:00:00`).getTime()
                      : null,
                  )
                }
                className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
              />
            </label>
            <button
              onClick={() => me?._id && setField("owner_id", me._id)}
              className="text-sol-cyan"
            >
              {item.owner_id === me?._id ? "Owned by you" : "Assign to me"}
            </button>
            {item.kind === "objective" && (
              <label className="block text-sol-text-dim">
                Success criteria (one per line)
                <textarea
                  defaultValue={item.success_criteria?.join("\n") ?? ""}
                  onBlur={(e) =>
                    setField(
                      "success_criteria",
                      e.target.value
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                    )
                  }
                  rows={3}
                  className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
                />
              </label>
            )}
            {item.kind === "bet" && (
              <>
                <DetailTextField
                  onCommit={setField}
                  label="Hypothesis"
                  field="hypothesis"
                  value={item.hypothesis}
                  multiline
                />
                <DetailTextField
                  onCommit={setField}
                  label="Resolution"
                  field="resolution_summary"
                  value={item.resolution_summary}
                  multiline
                />
              </>
            )}
            {item.kind === "initiative" && (
              <>
                <DetailTextField
                  onCommit={setField}
                  label="Intent"
                  field="intent"
                  value={item.intent}
                  multiline
                />
                <DetailTextField
                  onCommit={setField}
                  label="Rationale"
                  field="rationale"
                  value={item.rationale}
                  multiline
                />
                <label className="block text-sol-text-dim">
                  Success criteria (one per line)
                  <textarea
                    defaultValue={item.success_criteria?.join("\n") ?? ""}
                    onBlur={(e) =>
                      setField(
                        "success_criteria",
                        e.target.value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean),
                      )
                    }
                    rows={3}
                    className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
                  />
                </label>
                <DetailTextField
                  onCommit={setField}
                  label="Result"
                  field="result_summary"
                  value={item.result_summary}
                  multiline
                />
              </>
            )}
            {item.kind === "question" && (
              <>
                <DetailTextField
                  onCommit={setField}
                  label="Why it matters"
                  field="why_it_matters"
                  value={item.why_it_matters}
                  multiline
                />
                <DetailTextField
                  onCommit={setField}
                  label="Current answer"
                  field="current_answer"
                  value={item.current_answer}
                  multiline
                />
                <label className="block text-sol-text-dim">
                  Resolved date
                  <input
                    type="date"
                    defaultValue={
                      item.resolved_at
                        ? new Date(item.resolved_at).toISOString().slice(0, 10)
                        : ""
                    }
                    onBlur={(e) =>
                      setField(
                        "resolved_at",
                        e.target.value
                          ? new Date(`${e.target.value}T12:00:00`).getTime()
                          : null,
                      )
                    }
                    className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
                  />
                </label>
              </>
            )}
            <label className="block text-sol-text-dim">
              Primary parent
              <select
                value={item.parent_item_id ?? ""}
                onChange={(e) =>
                  setField("parent_item_id", e.target.value || null)
                }
                className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
              >
                <option value="">No parent</option>
                {parentOptions.map((candidate) => (
                  <option key={candidate._id} value={candidate._id}>
                    {candidate.title}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className="text-sol-text-dim">Order among siblings</span>
              <div className="mt-1 flex gap-2">
                <button
                  disabled={siblingIndex <= 0}
                  onClick={() => move(-1)}
                  className="rounded border border-sol-border px-2 py-1.5 text-sol-text disabled:opacity-35"
                >
                  Move up
                </button>
                <button
                  disabled={
                    siblingIndex < 0 || siblingIndex >= siblings.length - 1
                  }
                  onClick={() => move(1)}
                  className="rounded border border-sol-border px-2 py-1.5 text-sol-text disabled:opacity-35"
                >
                  Move down
                </button>
              </div>
            </div>
            {parent && (
              <button
                onClick={() => router.push(`/steering/map?id=${parent._id}`)}
                className="block text-sol-cyan text-left"
              >
                Open parent: {parent.title}
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-xs text-sol-red">
              {error}
            </p>
          )}
          <button
            onClick={async () => {
              if (confirm(`Delete ${item.title}?`)) {
                try {
                  await remove(item._id);
                  onBack();
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not delete item",
                  );
                }
              }
            }}
            className="mt-8 text-xs text-sol-red"
          >
            Delete item
          </button>
        </aside>
      </div>
    </div>
  );
}

export function SteeringWorkspace({
  view,
  selectedId,
  proposalId,
}: {
  view: SteeringView;
  selectedId: string | null;
  proposalId?: string | null;
}) {
  const inActiveWorkspace = useInActiveWorkspace();
  const router = useRouter();
  const record = useInboxStore((s) => s.steeringItems);
  const tasks = useInboxStore((s) => s.tasks);
  const me = useInboxStore((s) => s.currentUser);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind | "all">("all");
  const [creating, setCreating] = useState(false);
  const items = useMemo(
    () =>
      Object.values(record)
        .filter(inActiveWorkspace)
        .sort(
          (a, b) =>
            (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
            a.created_at - b.created_at,
        ),
    [record, inActiveWorkspace],
  );
  const selected = selectedId
    ? items.find((item) => item._id === selectedId || item.short_id === selectedId)
    : undefined;
  const filtered = useMemo(
    () =>
      items.filter(
        (i) =>
          (kind === "all" || i.kind === kind) &&
          (!query ||
            `${i.title} ${i.description ?? ""}`
              .toLowerCase()
              .includes(query.toLowerCase())),
      ),
    [items, kind, query],
  );
  const childrenByParent = useMemo(() => {
    const m = new Map<string, SteeringItem[]>();
    for (const i of filtered) {
      const key =
        i.parent_item_id && filtered.some((x) => x._id === i.parent_item_id)
          ? i.parent_item_id
          : "root";
      m.set(key, [...(m.get(key) ?? []), i]);
    }
    return m;
  }, [filtered]);
  const open = (id: string) => router.push(`/steering/map?id=${id}`);
  if (selected)
    return (
      <ItemDetail
        item={selected}
        items={items}
        onBack={() => router.push("/steering/map")}
      />
    );
  const recentlyChanged = [...items]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 6);
  if (view === "overview") {
    if (!items.length) {
      return <FirstRunRoom proposalId={proposalId} />;
    }
    const active = items.filter((item) => !["archived", "closed", "dropped"].includes(item.status));
    const roots = active.filter((item) => !item.parent_item_id);
    const primary = roots.find((item) => item.kind === "objective") ?? roots[0];
    const aroundPrimary = primary
      ? active.filter((item) => item._id === primary._id || item.parent_item_id === primary._id)
      : [];
    const surfaced = (kind: Kind) => aroundPrimary.find((item) => item.kind === kind);
    const objective = surfaced("objective");
    const bet = surfaced("bet");
    const initiative = surfaced("initiative");
    const question = surfaced("question");
    return (
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:py-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-sol-cyan">
              <Sparkles className="h-4 w-4" /> Strategic operating room
            </div>
            <h2 className="mt-3 max-w-3xl text-2xl font-semibold leading-tight text-sol-text sm:text-3xl">
              {objective?.title ?? "What are we trying to make true?"}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-sol-text-muted">
              {objective?.description ?? objective?.success_criteria?.[0] ?? "A living view of the reasoning connecting intent, uncertainty, and execution."}
            </p>
          </div>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-sol-border/50 bg-sol-card px-3 py-2 text-xs text-sol-text-muted hover:text-sol-text"
          >
            <Plus className="w-4 h-4" />
            Add to the map
          </button>
        </div>
        {creating && (
          <div className="mt-5">
            <CreateItem onClose={() => setCreating(false)} />
          </div>
        )}

        <div className="mt-9">
          <PortfolioConversation items={active} />
          <PendingProposalShelf focusId={proposalId} />
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_290px]">
          <section className="overflow-hidden rounded-2xl border border-sol-border/40 bg-sol-card">
            <div className="border-b border-sol-border/30 px-5 py-4">
              <p className="text-xs font-medium text-sol-text">The operating argument</p>
              <p className="mt-1 text-[11px] text-sol-text-dim">
                {primary ? `Only items explicitly nested under “${primary.title}” are grouped here.` : "No root branch is selected yet."}
              </p>
            </div>
            <div className="divide-y divide-sol-border/25">
              {[
                { label: "Root objective", item: objective, empty: "Name the change we want to make true", icon: Target },
                { label: "Nested bet", item: bet, empty: "No bet is nested in this branch", icon: CircleDot },
                { label: "Nested initiative", item: initiative, empty: "No initiative is nested in this branch", icon: Flag },
                { label: "Nested question", item: question, empty: "No question is nested in this branch", icon: HelpCircle },
              ].map((row) => (
                <button
                  key={row.label}
                  type="button"
                  onClick={() => row.item ? open(row.item._id) : setCreating(true)}
                  className="group flex w-full gap-4 px-5 py-5 text-left hover:bg-sol-bg-highlight/45"
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sol-bg-alt text-sol-cyan">
                    <row.icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] uppercase tracking-wide text-sol-text-dim">{row.label}</p>
                    <p className={`mt-1 text-base leading-6 ${row.item ? "text-sol-text" : "text-sol-text-dim"}`}>
                      {row.item?.title ?? row.empty}
                    </p>
                    {row.item?.description && <p className="mt-1 line-clamp-2 text-xs leading-5 text-sol-text-muted">{row.item.description}</p>}
                  </div>
                  <ChevronRight className="mt-3 h-4 w-4 text-sol-text-dim opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </section>

          <aside className="space-y-5">
            <section className="rounded-2xl border border-sol-cyan/20 bg-sol-cyan/[0.045] p-5">
              <MessageCircle className="h-5 w-5 text-sol-cyan" />
              <h3 className="mt-4 text-sm font-medium text-sol-text">Object-level room</h3>
              <p className="mt-2 text-xs leading-5 text-sol-text-muted">
                Open an item when the discussion needs its lineage, explicit relationships, and linked execution as context.
              </p>
              {primary && (
                <button onClick={() => open(primary._id)} className="mt-4 text-xs font-medium text-sol-cyan">
                  Open this steering room →
                </button>
              )}
            </section>
            <section className="rounded-2xl border border-sol-border/35 bg-sol-card p-5">
              <h3 className="text-xs font-medium text-sol-text">Recently reconsidered</h3>
              <div className="mt-3 space-y-3">
                {recentlyChanged.slice(0, 4).map((row) => (
                  <button key={row._id} onClick={() => open(row._id)} className="block w-full text-left">
                    <p className="truncate text-xs text-sol-text-muted hover:text-sol-text">{row.title}</p>
                    <p className="mt-0.5 text-[10px] capitalize text-sol-text-dim">{row.kind} · {new Date(row.updated_at).toLocaleDateString()}</p>
                  </button>
                ))}
              </div>
            </section>
          </aside>
        </div>

        <section className="mt-6 flex items-center justify-between rounded-xl border border-sol-border/30 px-4 py-3">
          <div>
            <p className="text-xs text-sol-text">Need the structural view?</p>
            <p className="text-[11px] text-sol-text-dim">The map keeps hierarchy and cross-links available without making them the front door.</p>
          </div>
          <button onClick={() => router.push("/steering/map")} className="text-xs text-sol-cyan">Open map →</button>
        </section>
      </div>
    );
  }
  if (view === "my-work") {
    const mine = items
      .filter((i) => i.owner_id === me?._id)
      .sort((a, b) => priorityWeight[a.priority] - priorityWeight[b.priority]);
    const assignedTasks = Object.values(tasks).filter(
      (t: any) =>
        inActiveWorkspace(t) &&
        (t.assignee === me?._id ||
          t.assignee === (me as any)?.username ||
          t.assignee === "me") &&
        !["done", "dropped"].includes(t.status),
    );
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <div className="flex items-center gap-2">
          <UserRound className="w-5 h-5 text-sol-cyan" />
          <h2 className="text-xl font-semibold text-sol-text">My work</h2>
        </div>
        <p className="mt-1 text-xs text-sol-text-dim">
          Deterministic ownership across Steering Items and Tasks.
        </p>
        <div className="mt-6 grid md:grid-cols-2 gap-5">
          <section>
            <h3 className="text-xs uppercase tracking-wide text-sol-text-dim">
              Steering items · {mine.length}
            </h3>
            <div className="mt-2 space-y-2">
              {mine.map((i) => (
                <button
                  key={i._id}
                  onClick={() => open(i._id)}
                  className="w-full rounded-lg border border-sol-border/30 bg-sol-card p-3 text-left"
                >
                  <KindMark item={i} />
                  <p className="mt-1 text-sm text-sol-text">{i.title}</p>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h3 className="text-xs uppercase tracking-wide text-sol-text-dim">
              Tasks · {assignedTasks.length}
            </h3>
            <div className="mt-2 space-y-2">
              {assignedTasks.map((t: any) => (
                <a
                  key={t._id}
                  href={`/tasks?id=${t._id}`}
                  className="block rounded-lg border border-sol-border/30 bg-sol-card p-3"
                >
                  <span className="text-[10px] text-sol-text-dim">
                    {t.short_id}
                  </span>
                  <p className="mt-1 text-sm text-sol-text">{t.title}</p>
                </a>
              ))}
            </div>
          </section>
        </div>
      </div>
    );
  }
  const roots = childrenByParent.get("root") ?? [];
  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 flex-1">
          <Layers3 className="w-5 h-5 text-sol-cyan" />
          <div>
            <h2 className="text-xl font-semibold text-sol-text">
              Portfolio map
            </h2>
            <p className="text-xs text-sol-text-dim">
              Mixed kinds nest wherever the work and learning belong.
            </p>
          </div>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-sol-cyan px-3 py-2 text-xs font-medium text-sol-bg"
        >
          <Plus className="w-4 h-4" />
          New root item
        </button>
      </div>
      <div className="mt-5 flex flex-col sm:flex-row gap-2">
        <label className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-sol-text-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter the map"
            className="w-full rounded-md border border-sol-border bg-sol-card pl-8 pr-3 py-2 text-xs text-sol-text outline-none focus:border-sol-cyan"
          />
        </label>
        <div className="flex gap-1 overflow-x-auto">
          <button
            onClick={() => setKind("all")}
            className={`px-2.5 py-2 rounded text-xs ${kind === "all" ? "bg-sol-cyan/12 text-sol-cyan" : "text-sol-text-muted"}`}
          >
            All
          </button>
          {KINDS.map((k) => (
            <button
              key={k.kind}
              onClick={() => setKind(k.kind)}
              className={`px-2.5 py-2 rounded text-xs whitespace-nowrap ${kind === k.kind ? "bg-sol-cyan/12 text-sol-cyan" : "text-sol-text-muted"}`}
            >
              {k.plural}
            </button>
          ))}
        </div>
      </div>
      {creating && (
        <div className="mt-4">
          <CreateItem onClose={() => setCreating(false)} />
        </div>
      )}
      <div className="mt-5 rounded-xl border border-sol-border/35 bg-sol-card p-2 sm:p-3">
        {roots.length ? (
          roots.map((i) => (
            <TreeNode
              key={i._id}
              item={i}
              childrenByParent={childrenByParent}
              depth={0}
              openItem={open}
            />
          ))
        ) : (
          <div className="py-14 text-center">
            <Target className="mx-auto w-8 h-8 text-sol-text-dim" />
            <h3 className="mt-3 text-sm text-sol-text">
              No Steering Items yet
            </h3>
            <p className="mt-1 text-xs text-sol-text-dim">
              Create an Objective, Bet, Initiative, or Question to begin.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
