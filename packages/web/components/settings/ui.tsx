import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The settings design kit. Every settings panel renders through these four
 *  shapes, so density, typography and spacing are decided once:
 *
 *    <SettingsPanel>                          the page: vertical rhythm
 *      <SettingsSection title icon>           small-caps header OVER a card
 *        <SettingsRow label control/>         one setting: text left, control right
 *        <SettingsLinkRow label onClick/>     a row that goes somewhere
 *      </SettingsSection>
 *    </SettingsPanel>
 *
 *  Tokens: text is sol-text / sol-text-muted / sol-text-dim, never the
 *  hard-coded base0X scale — those hexes ignore the light theme. The card is
 *  a hairline border over a barely raised surface; rows divide with a fainter
 *  hairline. Nothing here owns color beyond that: accents belong to controls.
 *
 *  One border per surface. The section card owns the only decorative border;
 *  everything inside it is flat — rows divided by hairlines, grouping via
 *  micro-headers, state via background tint and opacity. Interactive controls
 *  (inputs, dropdown triggers, option pills) keep their compact borders;
 *  containers, callouts and code blocks never add a second stroke — use
 *  SettingsCallout or a bg-tinted inset instead of a nested bordered box.
 */

export function SettingsPanel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div data-cc-settings className={cn("mx-auto max-w-3xl space-y-8 pb-6", className)}>{children}</div>;
}

interface SectionProps {
  title: React.ReactNode;
  icon?: LucideIcon;
  /** One sentence under the header, for sections whose name isn't enough. */
  description?: React.ReactNode;
  /** Right-aligned header slot: a switch that gates the section, a button. */
  actions?: React.ReactNode;
  /** Freeform content (editors, lists): pads the card instead of expecting rows. */
  padded?: boolean;
  /** Lets sticky children (a pinned save bar) escape the card's clipping. */
  overflowVisible?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function SettingsSection({ title, icon: Icon, description, actions, padded, overflowVisible, children, className }: SectionProps) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-center justify-between gap-4 px-1">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />}
          <h3 className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-sol-text-muted">{title}</h3>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {description && (
        <p className="mb-2.5 -mt-1 max-w-prose px-1 text-xs leading-relaxed text-sol-text-muted">{description}</p>
      )}
      <div
        className={cn(
          "rounded-xl border border-sol-border/80 bg-sol-bg-alt/30",
          overflowVisible ? "" : "overflow-hidden",
          padded ? "p-4 sm:p-5" : "divide-y divide-sol-border/40",
        )}
      >
        {children}
      </div>
    </section>
  );
}

interface RowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  /** Tall controls (textareas, button groups) sit better top-aligned. */
  alignTop?: boolean;
  disabled?: boolean;
  /** The control. A plain string renders as a quiet read-only value. */
  children?: React.ReactNode;
  className?: string;
}

export function SettingsRow({ label, description, icon: Icon, alignTop, disabled, children, className }: RowProps) {
  return (
    <div
      className={cn(
        "flex justify-between gap-6 px-4 py-3 sm:px-5",
        alignTop ? "items-start" : "items-center",
        disabled && "opacity-55",
        className,
      )}
    >
      <div className={cn("flex min-w-0 gap-3", alignTop ? "items-start" : "items-center")}>
        {Icon && <Icon className="mt-px h-4 w-4 shrink-0 text-sol-text-dim" />}
        <div className="min-w-0">
          <div className="text-sm text-sol-text">{label}</div>
          {description && (
            <div className="mt-0.5 max-w-prose text-xs leading-relaxed text-sol-text-muted">{description}</div>
          )}
        </div>
      </div>
      {children != null && (
        <div className={cn("flex shrink-0 items-center gap-2", alignTop && "pt-0.5")}>
          {typeof children === "string" ? <span className="text-sm text-sol-text-muted">{children}</span> : children}
        </div>
      )}
    </div>
  );
}

interface LinkRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  /** A short value shown before the chevron ("On", "3 devices"). */
  value?: React.ReactNode;
  onClick: () => void;
  className?: string;
}

/** A row that navigates — to another section, a page, a dialog. The only row
 *  that responds to hover, because it is the only row that is itself a target. */
export function SettingsLinkRow({ label, description, icon: Icon, value, onClick, className }: LinkRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center justify-between gap-6 px-4 py-3 text-left transition-colors sm:px-5",
        "hover:bg-sol-bg-highlight/40 focus-visible:bg-sol-bg-highlight/40 focus-visible:outline-none",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-sol-text-dim" />}
        <div className="min-w-0">
          <div className="text-sm text-sol-text">{label}</div>
          {description && (
            <div className="mt-0.5 max-w-prose text-xs leading-relaxed text-sol-text-muted">{description}</div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-sol-text-muted">
        {value && <span className="text-xs">{value}</span>}
        <ChevronRight className="h-4 w-4 text-sol-text-dim transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

interface FieldProps {
  label: React.ReactNode;
  htmlFor?: string;
  /** A short line under the control: current value, validation, a nudge. */
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/** A labelled form control inside a section card — the input-shaped sibling of
 *  SettingsRow, for panels that edit text rather than flip switches. */
export function SettingsField({ label, htmlFor, hint, children, className }: FieldProps) {
  return (
    <div className={cn("px-4 py-3.5 sm:px-5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-sol-text-muted">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint && <div className="mt-1.5 text-xs text-sol-text-muted">{hint}</div>}
    </div>
  );
}

/** A flat tinted notice inside a section card — the borderless replacement for
 *  nested warning/danger boxes. Color comes from background tint alone. */
export function SettingsCallout({
  tone = "info",
  className,
  children,
}: {
  tone?: "info" | "warning" | "danger";
  className?: string;
  children: React.ReactNode;
}) {
  const tint =
    tone === "danger"
      ? "bg-sol-red/10 text-sol-red"
      : tone === "warning"
        ? "bg-sol-yellow/10 text-sol-text"
        : "bg-sol-bg-highlight/40 text-sol-text-muted";
  return (
    <div className={cn("rounded-md px-3 py-2 text-xs leading-relaxed", tint, className)}>
      {children}
    </div>
  );
}

export interface SettingsOption {
  value: string;
  label: string;
  /** Card variant only: a sentence under the label. */
  description?: React.ReactNode;
  /** Card variant only: a small mono line (CLI flags). */
  mono?: string;
  title?: string;
}

/** The one "pick one of N" control for settings panels. Two shapes: `card`
 *  (multi-line bordered cards that share the row) and `pill` (compact
 *  single-line buttons). Active state is always a cyan border and tint with a
 *  cyan label; each option exposes its state via aria-pressed. */
export function SettingsOptionGroup({
  value,
  onChange,
  options,
  label,
  variant = "card",
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SettingsOption[];
  /** Accessible name for the group. */
  label: string;
  variant?: "card" | "pill";
  disabled?: boolean;
  className?: string;
}) {
  const isCard = variant === "card";
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              "border text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              isCard ? "flex-1 rounded-lg px-3 py-2.5" : "rounded-md px-2.5 py-1.5 text-xs font-medium",
              active
                ? "border-sol-cyan bg-sol-cyan/10"
                : "border-sol-border bg-sol-bg-alt text-sol-text-muted hover:border-sol-text-muted",
              active && !isCard && "text-sol-cyan",
              active && isCard && "text-sol-text",
            )}
          >
            {isCard ? (
              <>
                <div className={cn("text-sm font-medium", active && "text-sol-cyan")}>{opt.label}</div>
                {opt.description && <div className="mt-0.5 text-xs leading-snug opacity-70">{opt.description}</div>}
                {opt.mono && <div className="mt-1 font-mono text-[10px] opacity-50">{opt.mono}</div>}
              </>
            ) : (
              opt.label
            )}
          </button>
        );
      })}
    </div>
  );
}
