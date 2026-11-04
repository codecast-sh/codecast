// An Ops home row as data: the issue it is about, where it opens, its ref
// and title, the facts its second line carries, its Events and Users cells,
// and the acts a row or a selection takes (snooze, resolve, assign).
import { toast } from "sonner";
import { formatCallTime } from "@codecast/shared/entities";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import { opsHref } from "./opsPaths";
import { countWords, escalationWords, knownRelease, usersOf, usersText } from "./issuesModel";
import { foldedTitle, issueAttention, replayName, replayWho, type AttentionItem } from "./opsHomeModel";
import { failureLine } from "./appsModel";
import { nextSnoozes, type OpsSnoozes, type SnoozeChoice } from "./opsSnooze";
import { triage } from "./issueUndo";
import type { OpsGroup } from "./opsTypes";

/** The issue a row is about: an issue's own, or the one a replay signature names. */
export function itemGroup(it: AttentionItem): OpsGroup | null {
  return it.kind === "issue" || it.kind === "replay" || it.kind === "watch" ? it.group : null;
}

/** Every issue a row stands for: a folded row's variants, else its one issue. */
export function itemGroups(it: AttentionItem): OpsGroup[] {
  if (it.kind === "issue" && it.variants?.length) return it.variants;
  const g = itemGroup(it);
  return g ? [g] : [];
}

/** A replay signature naming an issue opens that issue, where its replays are the evidence. */
export function itemHref(it: AttentionItem): string {
  if (it.kind === "issue") return opsHref.issue(it.group.short_id || it.group._id);
  if (it.kind === "watch") return opsHref.metric(it.watch.short_id || it.watch._id);
  if (it.kind === "replay") return it.group ? opsHref.issue(it.group.short_id || it.group._id) : opsHref.replay(it.replay.short_id || it.replay._id);
  // A failing reader opens its source, whose overview names the reader, its failing calls and the watches it starves.
  return opsHref.home({ source: it.source.name });
}

export function itemRef(it: AttentionItem): string {
  if (it.kind === "issue") return it.group.short_id;
  if (it.kind === "watch") return it.watch.short_id;
  if (it.kind === "replay") return it.group?.short_id ?? it.replay.short_id;
  return it.source.short_id;
}

export function itemTitle(it: AttentionItem): string {
  if (it.kind === "issue") return it.variants?.length ? foldedTitle(it.variants.map((g) => g.title)) : it.group.title;
  if (it.kind === "watch") return it.watch.name;
  if (it.kind === "replay") return it.group?.title ?? replayName(it.replay);
  const n = it.health.problems?.length ?? 0;
  // Two or more failing pieces of one app are one row in the source's own headline (the overview's header and the Apps head say the same), never the first alone.
  if (n > 1) return `${it.source.name}: ${it.health.label}`;
  if (it.kind === "reader") return `${it.source.name} ${it.health.starves.reader.name} failing`;
  return it.source.name;
}

/** A watch value with its unit, or a dash for none. */
export const fmt = (n: number | null | undefined, unit?: string) => (n == null ? "—" : `${Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2)}${unit ? ` ${unit}` : ""}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** A count in a narrow cell: 12,400 reads 12.4k. */
export const compact = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString());

/**
 * A fact on a row's second line. Rank 1 never drops (the state's number: the
 * rate, the value against the line); rank 2 drops before it, rank 3 first.
 * `narrow` facts repeat a column, for widths where the columns are hidden.
 */
export type RowFact = { text: string; rank: 1 | 2 | 3; narrow?: boolean; mono?: boolean };

/** The facts a row's second line carries, most important first; the line drops the tail whole as it narrows. */
export function itemFacts(it: AttentionItem, now: number, groupById?: ReadonlyMap<string, Pick<OpsGroup, "title">>): RowFact[] {
  const out: (RowFact | null)[] = [];
  if (it.kind === "issue") {
    const g = it.group;
    const spike = it.state === "escalating" ? issueAttention(g, now)?.spike : null;
    const count = itemGroups(it).reduce((n, x) => n + x.count, 0);
    out.push(
      spike ? { text: escalationWords(spike), rank: 1 } : null,
      { text: `${count.toLocaleString()} ${countWords(g.kind, count).long}`, rank: 1, narrow: true },
      g.users ? { text: plural(g.users, "user"), rank: 2, narrow: true } : null,
      g.culprit ? { text: g.culprit, rank: 3, mono: true } : null,
      knownRelease(g.last_release) ? { text: `in ${knownRelease(g.last_release)!.slice(0, 12)}`, rank: 3, mono: true } : null,
    );
  } else if (it.kind === "reader") {
    // How the reader fails is the fact; the watches behind it are the expander after it, then every other failing piece of the app.
    out.push({ text: failureLine(it.health.starves.reader, now), rank: 1, mono: true });
    for (const p of it.health.problems ?? []) if (p.name !== it.health.starves.reader.name) out.push({ text: p.line, rank: 2, mono: true });
  } else if (it.kind === "source" && (it.health.problems?.length ?? 0) > 1) {
    // Each failing reader, action and check of the app, the first leading: the same list the Apps board says is failing now.
    (it.health.problems ?? []).forEach((p, i) => out.push({ text: p.line, rank: i === 0 ? 1 : 2, mono: true }));
  } else if (it.kind === "watch") {
    const w = it.watch;
    if (it.state === "erroring") {
      out.push(
        { text: (w.last_error ?? "no answer").slice(0, 120), rank: 1, mono: true },
        w.missed ? { text: `${plural(w.missed, "failed read")} in a row`, rank: 2 } : null,
        w.last_at ? { text: `last value ${relTimeShort(w.last_at, now)} ago`, rank: 3 } : null,
      );
    } else {
      out.push({ text: `${fmt(w.last_value, w.unit)} ${w.direction === "above" ? "above" : "below"} ${fmt(w.threshold, w.unit)}`, rank: 1 });
    }
  } else if (it.kind === "replay") {
    const r = it.replay;
    const errors = it.replays.reduce((n, x) => n + x.counts.errors, 0);
    const failed = it.replays.reduce((n, x) => n + x.counts.failed_requests, 0);
    const first = it.group ? null : r.group_ids.map((id) => groupById?.get(id)?.title).find(Boolean);
    const who = it.replays.length === 1 ? replayWho(r) : null;
    // Counts summed over a partial day of replays are floors, marked as the Replays tab marks its own.
    const atLeast = (n: number, one: string, many?: string) => (it.partial ? plural(n, one, many).replace(/^([\d,]+)/, "$1+") : plural(n, one, many));
    out.push(
      { text: it.replays.length > 1 ? `${atLeast(it.replays.length, "replay")} in 24h, ${atLeast(it.users, "person", "people")}` : atLeast(errors, "error"), rank: 1 },
      it.replays.length > 1 ? { text: atLeast(errors, "error"), rank: 2, narrow: true } : null,
      first ? { text: first, rank: 2 } : null,
      failed ? { text: atLeast(failed, "failed request"), rank: 2 } : null,
      who && !replayName(r).includes(who) ? { text: who, rank: 3 } : null,
      it.replays.length === 1 && r.duration_ms ? { text: formatCallTime(r.duration_ms), rank: 3 } : null,
    );
  } else {
    // The reason leads (it shrinks to fit). The health's own word is the row's pill, so it is never repeated here.
    const why = it.health.reason ?? it.source.last_error;
    out.push(why ? { text: why.slice(0, 160), rank: 1 } : null);
  }
  return out.filter((f): f is RowFact => !!f);
}

/**
 * The Events column, one unit down the list: events. An issue's (or the issue
 * a replay row names) since it opened; a replay row naming none counts the
 * error events its replays caught. Watches and sources have no events: a dash.
 */
export function rowEvents(it: AttentionItem): { n: number; tip: string } | null {
  const g = it.kind === "issue" || it.kind === "replay" ? it.group : null;
  if (it.kind === "issue" && it.variants?.length) {
    const n = it.variants.reduce((a, x) => a + x.count, 0);
    return { n, tip: `${n.toLocaleString()} ${countWords(g!.kind, n).long} across ${it.variants.length} variants` };
  }
  if (g) return { n: g.count, tip: `${g.count.toLocaleString()} ${countWords(g.kind, g.count).long} since ${new Date(g.first_seen).toLocaleDateString()}` };
  if (it.kind === "replay") {
    const n = it.replays.reduce((a, r) => a + r.counts.errors, 0);
    return { n, tip: `${n.toLocaleString()} error events across ${plural(it.replays.length, "replay")}` };
  }
  return null;
}

/** The Users column: the people an issue reached (a replay row's issue too), or the people its replays show; null when unknown. */
export function rowUsers(it: AttentionItem): string | null {
  // A replay row naming an issue counts the issue's people, the number its page and the Issues list give; replays alone count their own.
  const named = it.kind === "replay" && it.group ? usersOf(it.group) : null;
  if (it.kind === "replay" && !named) return compact(it.users);
  const g = it.kind === "issue" || it.kind === "replay" ? it.group : null;
  // A floor when people began counting after the issue opened, written as the issue page and the Issues list write it.
  const u = g ? usersOf(g) : null;
  return u ? usersText(u, false, compact) : null;
}

/** Snooze items, or with `choice` null wake them: a watch on the watch itself (the team's mute), the rest for this person. */
export function snoozeItems(items: AttentionItem[], choice: SnoozeChoice | null) {
  if (!items.length) return;
  const st = useInboxStore.getState();
  const now = Date.now();
  let bag = st.clientState.ui?.ops_snoozes as OpsSnoozes | undefined;
  for (const it of items) {
    if (it.kind === "watch") st.updateOpsWatch(it.watch._id, { muted_until: choice?.ms ? now + choice.ms : null });
    else bag = nextSnoozes(bag, it, choice, now);
  }
  if (items.some((it) => it.kind !== "watch")) st.updateClientUI({ ops_snoozes: bag });
  if (choice) {
    const what = items.length === 1 ? itemRef(items[0]) : `${items.length} items`;
    const verb = items.every((it) => it.kind === "watch") ? "Muted" : "Snoozed";
    toast(`${verb} ${what} ${choice.ms === null ? "until it gets worse" : `for ${choice.label}`}`, { action: { label: "Undo", onClick: () => snoozeItems(items, null) } });
  }
}

/** The issues behind items that can be resolved: an issue, or the issue a replay signature or a watch names. */
export function resolvableGroups(items: AttentionItem[]): OpsGroup[] {
  const out = new Map<string, OpsGroup>();
  for (const it of items) {
    if (it.kind === "watch") continue;
    for (const g of itemGroups(it)) if (g.status !== "resolved") out.set(g._id, g);
  }
  return [...out.values()];
}

/** Resolve the issues behind items, with the shared undo (z). */
export function resolveItems(items: AttentionItem[]): void {
  const groups = resolvableGroups(items);
  if (!groups.length) {
    toast("Nothing here resolves: watches and sources clear when they recover");
    return;
  }
  triage(groups, "resolved");
}

/** Put a person on the tasks behind items. Items with no task yet are counted, never given one silently. */
export function assignItems(items: AttentionItem[], assignee: string, name: string): void {
  const st = useInboxStore.getState();
  const withTask = items.filter((it) => it.task?.short_id);
  for (const it of withTask) void st.updateTask(it.task!.short_id!, { assignee });
  const missing = items.length - withTask.length;
  if (withTask.length) toast(`Assigned ${withTask.length === 1 ? withTask[0].task!.short_id : `${withTask.length} tasks`} to ${name}${missing ? `; ${missing} with no task yet` : ""}`);
  else toast(missing === 1 ? `${itemRef(items[0])} has no task yet: Fix files one` : `None of these has a task yet: Fix files one`);
}
