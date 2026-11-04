// A source's health as every surface shows it (sourceHealth.ts): the dot and
// its word, and the one press that fixes what it names. The fix happens where
// the person is: Resume and Resume import write through the store; Reconnect
// opens the connection card it needs.
import Link from "next/link";
import { RotateCcw, Play, PlugZap, Settings2, Eye, Send, ListX } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { opsHref } from "./opsPaths";
import { SETUP_HREF } from "./parts";
import type { HealthFix, SourceHealth } from "./sourceHealth";
import type { OpsSource } from "./opsTypes";
import "./sourceView.css";

export function HealthBadge({ health, title }: { health: Pick<SourceHealth, "tone" | "label" | "reason">; title?: string }) {
  return (
    <span className="ops-health" data-health={health.tone} title={title ?? health.reason ?? undefined}>
      <i aria-hidden />
      {health.label}
    </span>
  );
}

const FIX_LABEL: Record<HealthFix, string> = {
  resume: "Resume",
  reconnect: "Reconnect",
  resume_import: "Resume import",
  setup: "Set up",
  watches: "Open watches",
  calls: "Failing calls",
  check: "Send a test",
};

/** The fix a health names, as a button or a link; nothing when there is none. */
export function HealthFixButton({ source, health, primary = false, onCheck }: { source: Pick<OpsSource, "_id" | "name" | "provider" | "short_id" | "status">; health: Pick<SourceHealth, "fix" | "state">; primary?: boolean; /** Where the source's own overview is open, Send a test opens its check in place. */ onCheck?: () => void }) {
  const fix = health.fix;
  if (!fix) return null;
  const tone = primary ? "primary" : undefined;
  const store = () => useInboxStore.getState();
  if (fix === "check") {
    if (onCheck) return <button type="button" className="ops-btn" data-tone={tone} data-ops-fix={fix} onClick={onCheck}><Send className="w-3.5 h-3.5" />{FIX_LABEL[fix]}</button>;
    // Away from the source, the link opens the source's overview with its test-event check already open (#check).
    return <Link href={`${opsHref.home({ source: source.name })}#check`} className="ops-btn" data-tone={tone} data-ops-fix={fix} title={`Open ${source.name} with its test-event check`}><Send className="w-3.5 h-3.5" />{FIX_LABEL[fix]}</Link>;
  }
  if (fix === "calls") {
    return <Link href={opsHref.tab("apps", { app: source.short_id || source.name })} className="ops-btn" data-tone={tone} data-ops-fix={fix}><ListX className="w-3.5 h-3.5" />{FIX_LABEL[fix]}</Link>;
  }
  if (fix === "resume") {
    return <button type="button" className="ops-btn" data-tone={tone} data-ops-fix={fix} onClick={() => store().setOpsSourceStatus(source._id, "active")}>{health.state === "paused" ? <Play className="w-3.5 h-3.5" /> : <RotateCcw className="w-3.5 h-3.5" />}{health.state === "paused" ? "Resume" : "Retry"}</button>;
  }
  if (fix === "resume_import") {
    return <button type="button" className="ops-btn" data-tone={tone} data-ops-fix={fix} disabled={source.status !== "active"} onClick={() => store().startOpsReplayImport(source._id)}><RotateCcw className="w-3.5 h-3.5" />{FIX_LABEL[fix]}</button>;
  }
  const href = fix === "watches" ? (source.provider === "app" ? opsHref.tab("apps", { app: source.short_id || source.name }) : opsHref.tab("metrics", { source: source.name })) : fix === "reconnect" ? "/settings/integrations" : SETUP_HREF;
  const Icon = fix === "reconnect" ? PlugZap : fix === "watches" ? Eye : Settings2;
  // An app's checks live on its Apps page, so the link says where it goes.
  const label = fix === "watches" && source.provider === "app" ? "Open app" : FIX_LABEL[fix];
  return <Link href={href} className="ops-btn" data-tone={tone} data-ops-fix={fix}><Icon className="w-3.5 h-3.5" />{label}</Link>;
}
