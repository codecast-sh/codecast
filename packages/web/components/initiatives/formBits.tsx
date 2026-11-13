// The small buttons the goal and project editors share: a quiet text button
// and the Cancel / Save pair every inline form ends with.
import type { Plus } from "lucide-react";

export function GhostButton({ icon: Icon, children, onClick, ...rest }: { icon?: typeof Plus; children: React.ReactNode; onClick?: () => void } & Record<`data-${string}`, string | undefined>) {
  return (
    <button type="button" onClick={onClick} className="h-6 inline-flex items-center gap-1 px-1.5 rounded-md text-[11.5px] hover:bg-sol-bg-highlight/70 transition-colors" style={{ color: "var(--sol-text-muted)" }} {...rest}>
      {Icon && <Icon className="w-3 h-3" />} {children}
    </button>
  );
}

export function FormButtons({ submit, onCancel, onSubmit, disabled, ...rest }: { submit: string; onCancel: () => void; onSubmit?: () => void; disabled?: boolean } & Record<`data-${string}`, string | undefined>) {
  return (
    <>
      <button type="button" onClick={onCancel} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
      <button type={onSubmit ? "button" : "submit"} onClick={onSubmit} disabled={disabled} className="h-7 px-3 rounded-md text-[12px] font-medium disabled:opacity-45" style={{ background: "var(--sol-text)", color: "var(--sol-bg)" }} {...rest}>{submit}</button>
    </>
  );
}
