import { X } from "lucide-react";
import { useStatusNoticeStore, type StatusNotice } from "../hooks/useStatusNotice";

const TONE: Record<StatusNotice["tone"], { stripe: string; icon: string }> = {
  yellow: { stripe: "border-l-sol-yellow", icon: "text-sol-yellow" },
  orange: { stripe: "border-l-sol-orange", icon: "text-sol-orange" },
  red: { stripe: "border-l-sol-red", icon: "text-sol-red" },
};

/**
 * Bottom-left home for transient status notices (see useStatusNotice):
 * offline, storage degraded, CLI offline, tmux missing. Fixed to the viewport
 * corner opposite the sonner toasts, so a status that comes and goes never
 * shifts the layout and never sits over the header, the transcript or the
 * composer. Its own look — a tone stripe down the left edge on a flat card —
 * keeps it from reading as one more toast. The container ignores the pointer;
 * each card takes it back so its controls work.
 */
export function StatusNoticeStack() {
  const notices = useStatusNoticeStore((s) => s.notices);
  if (notices.size === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-4 left-4 z-40 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      aria-live="polite"
    >
      {[...notices].map(([id, n]) => (
        <NoticeCard key={id} {...n} />
      ))}
    </div>
  );
}

function NoticeCard({ tone, icon: Icon, title, detail, action, onDismiss }: StatusNotice) {
  const t = TONE[tone];
  return (
    <div
      role="status"
      className={`cc-status-notice pointer-events-auto flex items-start gap-2.5 rounded-md border border-sol-border border-l-[3px] bg-sol-card py-2.5 pl-3 pr-2 shadow-xl ${t.stripe}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${t.icon}`} />
      <div className="min-w-0 flex-1 text-sm leading-snug text-sol-text">
        <div>{title}</div>
        {detail && <div className="mt-0.5 text-xs text-sol-text-dim">{detail}</div>}
        {action && <div className="mt-1.5">{action}</div>}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="-mt-0.5 p-1 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
