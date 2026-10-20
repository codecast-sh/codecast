// "Went out in dp-N": the deploys that carried a problem's fix, as links to
// each deploy (deploys.md DP7). On a decision page and a problem's page, so a
// shipped fix leads to the deploy that put it live and what happened after.
import Link from "next/link";
import { Rocket } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { entityRoute } from "../../../lib/entityLinks";

export function DeployedIn({ taskId, className = "" }: { taskId: string | null | undefined; className?: string }) {
  const { data } = useQueryNoThrow(api.deploys.forTask, taskId ? { task_id: taskId as any } : "skip");
  const rows = (data ?? []).filter((d: { status: string }) => d.status !== "failed" && d.status !== "cancelled");
  if (!rows.length) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} data-deployed-in>
      <Rocket className="w-3 h-3 text-sol-green" aria-hidden />
      {rows.map((d: { short_id: string; target: string; status: string }, i: number) => (
        <Link key={d.short_id} href={entityRoute("deploy", d.short_id) ?? "#"} className="hover:text-sol-green" title={`${d.short_id}: ${d.status === "live" ? "went out" : "going out"} to ${d.target}`}>
          {i === 0 ? (d.status === "live" ? "went out in " : "going out in ") : ""}<span className="font-mono">{d.short_id}</span>
        </Link>
      ))}
    </span>
  );
}
