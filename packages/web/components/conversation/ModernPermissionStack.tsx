import { useState } from "react";
import { formatToolName } from "@codecast/shared/render";
import { MenuKeyCaps } from "../KeyboardShortcutsHelp";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { allowAllLedger } from "../consequential/ledgers";
import { alwaysAllowLabels, PermissionContext, PermissionSourceTag, ToolName, type PermissionViewItem } from "../PermissionCard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ModernAskCard } from "./ModernAsk";

// The permission prompt docked above the composer, in the Modern style
// (PermissionStackView branches here): the loud card every ask is
// (ModernAsk), "Allow <tool>?" at the reading size, what the agent said it is
// for, the call itself in mono on the tinted panel, and the answers as 32px
// Buttons: Approve (primary), Always allow with the rules it keeps, Allow all
// (through its consequential review), Deny with an optional reason. Several
// prompts stack as rows inside one card, each with its own 28px answers and
// the whole set answered from the card's foot. The y and n keys are the
// stack's (PermissionStack), unchanged.

function Preview({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <pre className="mt-3 max-h-40 overflow-auto rounded-control border border-sol-border bg-[var(--cc-m-tint)] px-3 py-2 font-mono text-meta leading-5 text-sol-text-secondary whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

/** The reason a denial sends the agent, typed in place of the answers. Enter denies, Escape puts the answers back. */
function DenyWithReason({ onDeny, onCancel }: { onDeny: (message?: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onDeny(reason.trim() || undefined); }} className="mt-3 flex min-w-0 items-center gap-2">
      <Input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }}
        placeholder="Tell the agent why (optional)"
        aria-label="Reason for denying"
        className="h-control-md min-w-0 flex-1 text-ui"
      />
      <Button type="submit" size="md" variant="danger">Deny</Button>
      <Button type="button" size="md" variant="ghost" onClick={onCancel}>Cancel</Button>
    </form>
  );
}

const keys = (
  <span className="hidden items-center gap-1 sm:flex">
    <MenuKeyCaps action="permission.approve" className="contents" />/<MenuKeyCaps action="permission.deny" className="contents" />
  </span>
);

export function ModernPermissionStack<PId extends string>({ pending, inflight, onApprove, onDeny, onAlwaysAllow, onApproveAll, onDenyAll, onAllowAll }: {
  pending: PermissionViewItem<PId>[];
  inflight: ReadonlySet<string>;
  onApprove: (id: PId) => void;
  onDeny: (id: PId, message?: string) => void;
  onAlwaysAllow?: (id: PId) => void;
  onApproveAll: () => void;
  onDenyAll: () => void;
  onAllowAll?: () => void;
}) {
  const [allowReview, setAllowReview] = useState(false);
  const [denying, setDenying] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const review = allowReview && onAllowAll && (
    <SwitchReview ledger={allowAllLedger({ pending: pending.length })} onClose={() => setAllowReview(false)} onConfirm={() => { setAllowReview(false); onAllowAll(); }} />
  );
  const allowAll = onAllowAll && (
    <Button type="button" size="md" variant="outline" onClick={() => setAllowReview(true)} aria-haspopup="dialog" data-allow-all title="Approve and stop asking for permission in this session">
      Allow all
    </Button>
  );

  if (pending.length === 1) {
    const p = pending[0];
    const rules = alwaysAllowLabels(p);
    const busy = inflight.has(p._id);
    return (
      <ModernAskCard
        kicker={<><ToolName name={p.tool_name} className="font-mono" /><PermissionSourceTag permission={p} /></>}
        aside={keys}
        question={`Allow ${formatToolName(p.tool_name) || p.tool_name}?`}
        data-permission-card="modern"
        className="!my-1"
      >
        <PermissionContext permission={p} />
        <Preview text={p.arguments_preview} />
        {denying === p._id ? (
          <DenyWithReason onDeny={(message) => onDeny(p._id, message)} onCancel={() => setDenying(null)} />
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" size="md" variant="primary" disabled={busy} onClick={() => onApprove(p._id)}>Approve</Button>
            {onAlwaysAllow && rules.length > 0 && (
              <Button type="button" size="md" variant="outline" title={rules.join("\n")} data-always-allow onClick={() => onAlwaysAllow(p._id)} className="max-w-full min-w-0">
                <span className="shrink-0">Always allow</span>
                <span className="min-w-0 truncate font-mono text-meta text-sol-text-muted">{rules.join(", ")}</span>
              </Button>
            )}
            {allowAll}
            <Button type="button" size="md" variant="outline" disabled={busy} onClick={() => setDenying(p._id)}>Deny</Button>
          </div>
        )}
        {review}
      </ModernAskCard>
    );
  }

  const sameTool = pending.every((p) => p.tool_name === pending[0].tool_name);
  return (
    <ModernAskCard
      kicker={sameTool ? <ToolName name={pending[0].tool_name} className="font-mono" /> : undefined}
      aside={keys}
      question={`Allow ${pending.length} calls?`}
      data-permission-card="modern"
      className="!my-1"
    >
      <ul className="divide-y divide-sol-border rounded-control border border-sol-border">
        {pending.map((p) => (
          <li key={p._id} className="px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {!sameTool && <ToolName name={p.tool_name} className="text-meta font-medium" />}
              <PermissionSourceTag permission={p} />
              <button
                type="button"
                onClick={() => setOpenId(openId === p._id ? null : p._id)}
                aria-expanded={openId === p._id}
                className="min-w-0 flex-1 truncate text-left font-mono text-meta text-sol-text-muted hover:text-sol-text"
                title={p.arguments_preview}
              >
                {p.arguments_preview || formatToolName(p.tool_name)}
              </button>
              <Button type="button" size="sm" variant="outline" onClick={() => onApprove(p._id)}>Approve</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDenying(denying === p._id ? null : p._id)}>Deny</Button>
            </div>
            {openId === p._id && <Preview text={p.arguments_preview} />}
            {denying === p._id && <DenyWithReason onDeny={(message) => onDeny(p._id, message)} onCancel={() => setDenying(null)} />}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="md" variant="primary" onClick={onApproveAll}>Approve all</Button>
        {allowAll}
        <Button type="button" size="md" variant="outline" onClick={onDenyAll}>Deny all</Button>
      </div>
      {review}
    </ModernAskCard>
  );
}
