import { useCallback } from "react";
import type { MentionItem } from "../components/editor/MentionList";
import { useInboxStore } from "../store/inboxStore";

export type MentionScope =
  | { kind: "team"; teamId: string }
  | { kind: "personal"; userId: string }
  | { kind: "any" };

const RECENT_LIMIT_PER_TYPE = 6;
const SEARCH_LIMIT_PER_TYPE = 12;

function inScope(item: { team_id?: string | null; user_id?: string | null }, scope: MentionScope): boolean {
  if (scope.kind === "any") return true;
  const itemTeam = item.team_id ? String(item.team_id) : null;
  if (scope.kind === "team") return itemTeam === scope.teamId;
  return !itemTeam && (item.user_id ? String(item.user_id) === scope.userId : true);
}

function score(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  const idx = l.indexOf(q);
  return idx === -1 ? Infinity : 2 + idx;
}

export function useMentionQuery(scope: MentionScope = { kind: "any" }) {
  const getStore = useInboxStore.getState;
  const scopeKey = scope.kind === "team"
    ? `team:${scope.teamId}`
    : scope.kind === "personal"
      ? `personal:${scope.userId}`
      : "any";

  return useCallback(async (rawQ: string): Promise<MentionItem[]> => {
    const q = rawQ.trim().toLowerCase();
    const s = getStore();
    const idx = s.mentionIndex || { tasks: {}, docs: {}, plans: {} };

    const taskItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const t of Object.values(idx.tasks)) {
      if (!inScope(t, scope)) continue;
      const r = q ? score(t.title || "", q) : 0;
      if (q && r === Infinity) {
        if (!t.short_id?.toLowerCase().includes(q)) continue;
      }
      taskItems.push({
        item: {
          id: t._id,
          type: "task",
          label: t.title,
          sublabel: t.short_id,
          shortId: t.short_id,
          status: t.status,
          priority: t.priority,
        },
        rank: r === Infinity ? 99 : r,
        updated: t.updated_at || 0,
      });
    }

    const docItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const d of Object.values(idx.docs)) {
      if (!inScope(d, scope)) continue;
      const r = q ? score(d.title || "", q) : 0;
      if (q && r === Infinity) continue;
      docItems.push({
        item: {
          id: d._id,
          type: "doc",
          label: d.title,
          sublabel: d.doc_type || "note",
          docType: d.doc_type,
        },
        rank: r === Infinity ? 99 : r,
        updated: d.updated_at || 0,
      });
    }

    const planItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const p of Object.values(idx.plans)) {
      if (!inScope(p, scope)) continue;
      const labelHit = q ? score(p.title || "", q) : 0;
      const goalHit = q && p.goal ? score(p.goal, q) : Infinity;
      const r = Math.min(labelHit, goalHit);
      if (q && r === Infinity) {
        if (!p.short_id?.toLowerCase().includes(q)) continue;
      }
      planItems.push({
        item: {
          id: p._id,
          type: "plan",
          label: p.title,
          sublabel: p.short_id,
          shortId: p.short_id,
          status: p.status,
          goal: p.goal,
        },
        rank: r === Infinity ? 99 : r,
        updated: p.updated_at || 0,
      });
    }

    const sessionItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const sess of Object.values(s.sessions)) {
      const sessTeam = sess.team_id ? String(sess.team_id) : null;
      const inScopeForSession =
        scope.kind === "any"
          ? true
          : scope.kind === "team"
            ? sessTeam === scope.teamId
            : !sessTeam;
      if (!inScopeForSession) continue;
      const titleHit = q ? score(sess.title || "", q) : 0;
      const summaryHit = q && sess.idle_summary ? score(sess.idle_summary, q) : Infinity;
      const r = Math.min(titleHit, summaryHit);
      if (q && r === Infinity) continue;
      sessionItems.push({
        item: {
          id: sess._id,
          type: "session",
          label: sess.title || "Untitled Session",
          sublabel: sess.idle_summary?.slice(0, 80) || undefined,
          messageCount: sess.message_count,
          projectPath: sess.project_path,
          status: sess.agent_status,
          agentType: sess.agent_type,
          updatedAt: sess.updated_at,
          idleSummary: sess.idle_summary,
        },
        rank: r === Infinity ? 99 : r,
        updated: sess.updated_at || 0,
      });
    }

    const personItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const m of s.teamMembers || []) {
      const name = (m.name || "").toLowerCase();
      const username = (m.github_username || "").toLowerCase();
      if (q && !name.includes(q) && !username.includes(q)) continue;
      personItems.push({
        item: {
          id: String(m._id),
          type: "person",
          label: m.name || m.github_username || "Unknown",
          sublabel: m.github_username ? `@${m.github_username}` : m.email,
          image: m.image || m.github_avatar_url,
          shortId: m.github_username ? `@${m.github_username}` : undefined,
        },
        rank: 0,
        updated: 0,
      });
    }

    const limit = q ? SEARCH_LIMIT_PER_TYPE : RECENT_LIMIT_PER_TYPE;
    const sortAndTake = (arr: typeof taskItems) =>
      arr
        .sort((a, b) => a.rank - b.rank || b.updated - a.updated)
        .slice(0, limit)
        .map((x) => x.item);

    return [
      ...sortAndTake(personItems),
      ...sortAndTake(sessionItems),
      ...sortAndTake(taskItems),
      ...sortAndTake(docItems),
      ...sortAndTake(planItems),
    ];
  }, [getStore, scopeKey]);
}
