"use client";

import { useMemo, useState } from "react";
import { BookOpen, CalendarClock, MessageSquare, Plus } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api as convexApi } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import { useWorkspaceArgs } from "../../hooks/useWorkspaceArgs";

export function StrategySection() {
  const workspace = useWorkspaceArgs();
  const inActiveWorkspace = (row: { team_id?: string }) =>
    workspace !== "skip" &&
    (workspace.workspace === "team"
      ? row.team_id === workspace.team_id
      : workspace.workspace === "personal"
        ? !row.team_id
        : true);
  const strategies = useInboxStore((s) => s.strategies);
  const items = useInboxStore((s) => s.steeringItems);
  const me = useInboxStore((s) => s.currentUser);
  const create = useInboxStore((s) => s.createStrategy);
  const updateMutation = useMutation((convexApi as any).strategies.webUpdate);
  const strategy = useMemo(
    () =>
      Object.values(strategies)
        .filter(inActiveWorkspace)
        .sort(
          (a, b) =>
            Number(b.status === "active") - Number(a.status === "active") ||
            b.updated_at - a.updated_at,
        )[0],
    [strategies, workspace],
  );
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(strategy?.title ?? "");
  const [createError, setCreateError] = useState("");
  const update = async (id: string, fields: Record<string, any>) => {
    try {
      setCreateError("");
      await updateMutation({ id, ...fields });
    } catch (cause) {
      setCreateError(
        cause instanceof Error ? cause.message : "Could not update strategy",
      );
    }
  };
  const links = useQuery(
    (convexApi as any).objectLinks.webListForEntity,
    strategy ? { entity_type: "strategy", entity_id: strategy._id } : "skip",
  ) as any;
  const linkedItemIds = new Set<string>(
    strategy && links
      ? [
          ...links.outgoing
            .filter((l: any) => l.to_type === "steering_item")
            .map((l: any) => l.to_id),
          ...links.incoming
            .filter((l: any) => l.from_type === "steering_item")
            .map((l: any) => l.from_id),
        ]
      : [],
  );
  const informedItems = Object.values(items).filter(
    (i) => inActiveWorkspace(i) && linkedItemIds.has(i._id),
  );
  if (!strategy)
    return (
      <div className="max-w-3xl mx-auto py-12">
        <BookOpen className="w-9 h-9 text-sol-cyan" />
        <h2 className="mt-4 text-2xl font-semibold text-sol-text">
          Write the argument behind the portfolio
        </h2>
        <p className="mt-2 text-sm leading-6 text-sol-text-muted">
          Strategy is a versioned synthesis of the situation, beliefs, choices,
          and exclusions. It remains a readable document—not another backlog
          item.
        </p>
        {creating ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!title.trim()) return;
              try {
                setCreateError("");
                await create({ title: title.trim(), status: "draft" });
                setCreating(false);
              } catch (cause) {
                setCreateError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not create strategy",
                );
              }
            }}
            className="mt-6 flex gap-2"
          >
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Strategy title"
              className="flex-1 rounded-md border border-sol-border bg-sol-card px-3 py-2 text-sm text-sol-text outline-none focus:border-sol-cyan"
            />
            <button className="rounded-md bg-sol-cyan px-3 text-xs font-medium text-sol-bg">
              Create draft
            </button>
            {createError && (
              <p role="alert" className="text-xs text-sol-red">
                {createError}
              </p>
            )}
          </form>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-sol-cyan px-3 py-2 text-xs font-medium text-sol-bg"
          >
            <Plus className="w-4 h-4" />
            Create strategy
          </button>
        )}
      </div>
    );
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_280px] gap-7">
      <article className="min-w-0">
        <div className="flex items-center gap-2 text-xs text-sol-text-dim">
          <BookOpen className="w-4 h-4 text-sol-cyan" />
          <span className="capitalize">{strategy.status}</span>
          <span>·</span>
          <span>{strategy.short_id}</span>
        </div>
        {editing ? (
          <div className="mt-3 flex gap-2">
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              className="flex-1 bg-transparent border-b border-sol-cyan text-2xl font-semibold text-sol-text outline-none"
            />
            <button
              onClick={() => {
                update(strategy._id, { title: draftTitle.trim() });
                setEditing(false);
              }}
              className="text-xs text-sol-cyan"
            >
              Save
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setDraftTitle(strategy.title);
              setEditing(true);
            }}
            className="mt-2 text-left"
          >
            <h2 className="text-2xl font-semibold tracking-tight text-sol-text">
              {strategy.title}
            </h2>
          </button>
        )}
        <div className="mt-6 rounded-xl border border-sol-border/35 bg-sol-card p-5 sm:p-7">
          <p className="text-sm leading-7 text-sol-text-muted">
            The structured strategy narrative lives in its linked document. Link
            the Doc that captures the situation, beliefs, approach, choices, and
            explicit exclusions.
          </p>
          {strategy.doc_id ? (
            <a
              href={`/docs/${strategy.doc_id}`}
              className="mt-4 inline-flex text-xs text-sol-cyan"
            >
              Open strategy document →
            </a>
          ) : (
            <label className="mt-4 block text-xs text-sol-text-dim">
              Link an existing Doc ID
              <input
                placeholder="Paste Doc ID"
                onBlur={(e) => {
                  if (e.target.value.trim())
                    update(strategy._id, { doc_id: e.target.value.trim() });
                }}
                className="mt-1 w-full rounded border border-sol-border bg-sol-bg px-3 py-2 text-sol-text"
              />
            </label>
          )}
        </div>
        {createError && (
          <p role="alert" className="mt-3 text-xs text-sol-red">
            {createError}
          </p>
        )}
        <div
          className="mt-7 border-t border-sol-border/30 pt-5"
          data-steering-conversation-slot={strategy._id}
        >
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-sol-cyan" />
            <h3 className="text-sm font-medium text-sol-text">
              Strategy conversation
            </h3>
          </div>
          <p className="mt-2 text-xs text-sol-text-dim">
            The reusable contextual conversation panel mounts here in ct-40647.
          </p>
        </div>
      </article>
      <aside className="lg:border-l lg:border-sol-border/30 lg:pl-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-sol-text-dim">
          Strategy state
        </h3>
        <div className="mt-3 space-y-3 text-xs">
          <label className="block text-sol-text-dim">
            Lifecycle
            <select
              value={strategy.status}
              onChange={(e) =>
                update(strategy._id, { status: e.target.value as any })
              }
              className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
            >
              <option>draft</option>
              <option>active</option>
              <option>archived</option>
            </select>
          </label>
          <label className="block text-sol-text-dim">
            Review date
            <input
              type="date"
              defaultValue={
                strategy.review_at
                  ? new Date(strategy.review_at).toISOString().slice(0, 10)
                  : ""
              }
              onBlur={(e) =>
                update(strategy._id, {
                  review_at: e.target.value
                    ? new Date(`${e.target.value}T12:00:00`).getTime()
                    : null,
                })
              }
              className="mt-1 w-full rounded border border-sol-border bg-sol-card px-2 py-2 text-sol-text"
            />
          </label>
          <button
            onClick={() =>
              me?._id && update(strategy._id, { owner_id: me._id })
            }
            className="text-sol-cyan"
          >
            {strategy.owner_id === me?._id ? "Owned by you" : "Assign to me"}
          </button>
        </div>
        <h3 className="mt-7 text-xs font-semibold uppercase tracking-wide text-sol-text-dim">
          Linked portfolio
        </h3>
        <div className="mt-3 space-y-2">
          {links === undefined ? (
            <p className="text-xs text-sol-text-dim">Loading links…</p>
          ) : informedItems.length ? (
            informedItems.map((item) => (
              <a
                key={item._id}
                href={`/steering/map?id=${item._id}`}
                className="block rounded-md border border-sol-border/30 bg-sol-card p-2.5"
              >
                <span className="text-[10px] uppercase text-sol-cyan">
                  {item.kind}
                </span>
                <p className="mt-0.5 text-xs text-sol-text line-clamp-2">
                  {item.title}
                </p>
              </a>
            ))
          ) : (
            <p className="text-xs text-sol-text-dim">
              No Steering Items linked to this strategy.
            </p>
          )}
        </div>
        {strategy.review_at && (
          <div className="mt-6 flex gap-2 text-xs text-sol-text-dim">
            <CalendarClock className="w-4 h-4" />
            <span>
              Review {new Date(strategy.review_at).toLocaleDateString()}
            </span>
          </div>
        )}
      </aside>
    </div>
  );
}
