import { AppLoader } from "../AppLoader";
import { useState, useMemo, memo, Fragment, type ReactNode } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { withSafetyBlock, SAFETY_BLOCK_HINT, PROVIDER_KEYS, getProviderKeySpec, computeConversationTaskStats, isSessionActivityFresh } from "@codecast/shared/contracts";
import { LimitParkCard } from "../LimitParkCard";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { toast } from "sonner";
import { formatElapsedClock, shouldShowElapsed } from "../workingStatus";
import { activitySig } from "../../lib/sessionActivity";
import { LivePulseDot } from "../SessionActivityLine";
import { AgentTypeIcon, formatAgentType } from "../AgentTypeIcon";
import { HeaderModelControl } from "../SessionControlMenu";
import { useLiveSessionMeta } from "../../hooks/useLiveSessionMeta";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { OwnerAvatar, type HandoffInfo } from "../OwnersBadge";
import { copyToClipboard } from "../../lib/utils";
import { useImageGallery, type GalleryImage } from "../ImageGallery";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { Circle, CircleDot, CheckCircle2, ChevronDown, ChevronRight, Check, KeyRound, ExternalLink, Loader2, ArrowRightLeft } from "lucide-react";
import { useDevices, useDeviceMoveStatus } from "../DeviceBadge";
import { useProviderKeyCommand, deviceManagedKeys } from "../../lib/useProviderKeyCommand";
import type { RestartPhase, RestartStage } from "../../hooks/useSessionRestart";
import { CopyCommand } from "./blocks/shared";
import { authRemedy, detectProviderFromError } from "./classify";
import { formatDuration, formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { MessageMarkdown } from "./markdown";
import type { ConversationDensity, ParsedApiError } from "./types";
import { DENSITY_OPTIONS } from "../../lib/conversationDensity";

// The density dropdown's option list. Guests (unauthenticated share-link
// viewers) get the local render densities only — the AI retellings need an
// account to read or generate (storyMode auth-gates both).
export function DensityMenuOptions({ density, setDensity, guest }: { density: ConversationDensity; setDensity: (d: ConversationDensity) => void; guest: boolean }) {
  const options = guest ? DENSITY_OPTIONS.filter((o) => !o.ai) : DENSITY_OPTIONS;
  return (
    <>
      {options.map((opt, i) => (
        <Fragment key={opt.value}>
          {opt.ai && !options[i - 1]?.ai && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => setDensity(opt.value)} className="items-start gap-2.5 py-2">
            <opt.icon className={`w-4 h-4 mt-0.5 shrink-0 ${density === opt.value ? "text-sol-cyan" : "text-sol-text-dim"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px]">
                <span className={density === opt.value ? "text-sol-cyan font-medium" : ""}>{opt.label}</span>
                {opt.ai && <span className="text-[9px] uppercase tracking-wider px-1 py-px rounded bg-sol-violet/15 text-sol-violet">AI</span>}
              </div>
              <div className="text-[11px] text-sol-text-dim leading-snug">{opt.description}</div>
            </div>
            {density === opt.value && <Check className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sol-cyan" />}
          </DropdownMenuItem>
        </Fragment>
      ))}
    </>
  );
}
// Children render only while the header row is squeezed past level 4 (see
// useSqueezeToFit and the .cq-sq4 tier): the overflow menu mounts its content
// on open, so reading the row's attribute here sees the level at that moment.
export function SqueezedHeaderActions({ rowRef, children }: { rowRef: React.RefObject<HTMLElement | null>; children: React.ReactNode }) {
  if (!rowRef.current?.matches('[data-squeeze~="4"]')) return null;
  return <>{children}</>;
}

// Header entry to the session gallery: every image in the transcript, opened
// over the lightbox's explicit-list channel (openList) — the register() channel
// only knows images the virtualized feed has actually mounted. Rendered inside
// ImageGalleryProvider (a child, not the ConversationView body, which sits
// outside the provider).
export function SessionGalleryButton({ images }: { images: GalleryImage[] }) {
  const gallery = useImageGallery();
  if (images.length === 0) return null;
  return (
    <ShortcutTooltip label={`View ${images.length === 1 ? "image" : `${images.length} images`}`} side="bottom">
      <button
        onClick={() => gallery?.openList(images, images.length - 1)}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 bg-sol-magenta/10 text-sol-magenta border border-sol-magenta/30 hover:bg-sol-magenta/20 transition-colors"
      >
        <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span className="tabular-nums">{images.length}</span>
      </button>
    </ShortcutTooltip>
  );
}

function ForkCopyingState({ copied, total }: { copied: number; total?: number }) {
  const pct = total && total > 0 ? Math.min(100, Math.round((copied / total) * 100)) : null;
  return (
    <div className="flex flex-col items-center gap-3 max-w-md text-center px-6">
      <div className="flex items-center gap-2 text-sm font-medium text-sol-text">
        <svg className="w-4 h-4 animate-spin text-sol-cyan" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        Copying messages from parent…
      </div>
      <div className="text-xs text-sol-text-dim tabular-nums">
        {total
          ? `${copied.toLocaleString()} / ${total.toLocaleString()} messages${pct !== null ? ` · ${pct}%` : ""}`
          : `${copied.toLocaleString()} messages copied so far`}
      </div>
      {total && total > 0 && (
        <div className="w-full max-w-xs h-1.5 rounded-full bg-sol-bg-alt overflow-hidden">
          <div
            className="h-full bg-sol-cyan transition-all duration-500"
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
      )}
      <div className="text-[11px] text-sol-text-dim/60">
        Large forks copy in batches. Messages will appear automatically as they arrive.
      </div>
    </div>
  );
}

// A captioned rule across the timeline: two gradient lines meeting the caption
// in the middle. One shape for every anchor the feed draws — the "New" unread
// line, the "assigned to you" handoff line, the idle-gap stamp at the tail.
export function TimelineRule({
  color,
  className = "mt-1 mb-3",
  faint,
  label,
  children,
}: {
  color: string;
  className?: string;
  faint?: boolean;
  label?: string;
  children: ReactNode;
}) {
  const line = `flex-1 h-px${faint ? " opacity-40" : ""}`;
  return (
    <div className={`flex items-center gap-3 select-none ${className}`} aria-label={label}>
      <div className={line} style={{ background: `linear-gradient(to right, transparent, ${color})` }} />
      {children}
      <div className={line} style={{ background: `linear-gradient(to left, transparent, ${color})` }} />
    </div>
  );
}

// One handoff, drawn where it landed in the timeline: the rule names who
// passed the session to whom, and the note they wrote sits under it as a
// message from the assigner. Every viewer sees it — it is the record of the
// transfer, not a private ping (that is AssignedToYouBanner, for the assignee
// until they acknowledge). A transfer still in flight renders dimmed.
export function HandoffMarker({ handoff, meId }: { handoff: HandoffInfo; meId?: string }) {
  const from = handoff.from === meId ? "You" : handoff.from_name;
  const to = handoff.to === meId ? "you" : handoff.to_name;
  return (
    <div className={`mt-2 mb-3 ${handoff.pending ? "opacity-70" : ""}`} data-handoff-marker={handoff.to}>
      <TimelineRule color="var(--sol-violet)" className="mb-2" label={`${from} handed this to ${to}`}>
        <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-sol-violet" title={formatFullTimestamp(handoff.at)}>
          <span className="flex items-center -space-x-1.5">
            <span className="rounded-full ring-2 ring-sol-bg"><OwnerAvatar name={handoff.from_name} image={handoff.from_image ?? undefined} size="w-5 h-5" /></span>
            <span className="rounded-full ring-2 ring-sol-bg"><OwnerAvatar name={handoff.to_name} image={handoff.to_image ?? undefined} size="w-5 h-5" /></span>
          </span>
          {from} handed this to {to} · {formatRelativeTime(handoff.at)}
        </span>
      </TimelineRule>
      {handoff.note && (
        <div className="mx-auto max-w-[640px] rounded-lg border border-sol-violet/35 bg-sol-violet/[0.07] px-3.5 py-2.5">
          <div className="flex items-center gap-2 mb-1.5 text-[11px]">
            <OwnerAvatar name={handoff.from_name} image={handoff.from_image ?? undefined} size="w-4 h-4" />
            <span className="font-semibold text-sol-text">{handoff.from_name}</span>
            <ArrowRightLeft className="w-3 h-3 text-sol-violet" />
            <OwnerAvatar name={handoff.to_name} image={handoff.to_image ?? undefined} size="w-4 h-4" />
            <span className="font-semibold text-sol-text">{handoff.to_name}</span>
            {handoff.seen && handoff.to !== meId && (
              <span className="ml-auto text-[10px] text-sol-text-dim">seen</span>
            )}
          </div>
          <div className="text-sm text-sol-text leading-relaxed [&_p]:my-0">
            <MessageMarkdown content={handoff.note} userText />
          </div>
        </div>
      )}
    </div>
  );
}

// Single sticky pill at the top/bottom edge of the message list. The leading
// icon is a directional chevron when idle and a spinner while a page is
// loading — same pill, glyph swaps in place (no second stacked pill).
export function EdgeMessagesIndicator({
  dir,
  loading,
  children,
}: {
  dir: "up" | "down";
  loading: boolean;
  children: React.ReactNode;
}) {
  const isUp = dir === "up";
  return (
    <div data-cc-edge={dir} className={`sticky ${isUp ? "top-0" : "bottom-0"} z-10 flex justify-center py-1 sm:py-2 pointer-events-none`}>
      <div className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full bg-sol-bg border border-sol-border text-sol-text-muted0 text-[10px] sm:text-xs shadow-sm pointer-events-auto">
        {loading ? (
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        ) : (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isUp ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
          </svg>
        )}
        {children}
      </div>
    </div>
  );
}

export function MessagesUnavailableState({
  forkStatus,
  forkCopied,
  forkTotal,
}: {
  messageCount: number;
  forkStatus?: "copying" | "complete" | "failed";
  forkCopied?: number;
  forkTotal?: number;
}) {
  if (forkStatus === "copying") {
    return <ForkCopyingState copied={forkCopied ?? 0} total={forkTotal} />;
  }

  // No "couldn't be loaded" panic — the recovery loop in useConversationMessages
  // keeps trying every second. Just show the loader; if it never lands the user
  // will see this indicator rather than a misleading error.
  return <AppLoader className="min-h-0 bg-transparent py-10" size={32} />;
}

// Is the block this banner describes still in force? The conversation row's
// pending_api_error is server-derived and clears the moment anything supersedes
// the banner: a later turn, a message send, an account switch (accountSwitch
// clears it on revive). Reading it live keeps a card honest after the fact —
// an hours-old "Usage limit reached" must not still read as the current state
// once the session moved on. A row missing from the store (not in this viewer's
// inbox window) is treated as still live: the banner is the newest thing we
// know about, so the neutral guess is "unresolved".
function useApiErrorLive(conversationId?: string): boolean {
  return useInboxStore((s) => {
    if (!conversationId) return true;
    const row = s.sessions[conversationId];
    if (!row) return true;
    return withSafetyBlock(row).pending_api_error === true;
  });
}

export function ApiErrorCard({ error, agentType, conversationId, timestamp, compact = false }: { error: ParsedApiError; agentType?: string; conversationId?: string; timestamp?: number; compact?: boolean }) {
  const live = useApiErrorLive(conversationId);
  // A usage-limit park has its own card: fixed shape in every density, the
  // reset counted down in the viewer's clock, and the owner machine's
  // recovery flags read into a "what happens next" line.
  if (error.isLimit) {
    return <LimitParkCard message={error.message} timestamp={timestamp} conversationId={conversationId} live={live} compact={compact} />;
  }
  const isServerError = !error.isAuth && !error.isLimit && !error.isConnection && !error.isThrottle && (error.statusCode ?? 0) >= 500;

  // Tone: amber (or red for a provider 5xx) while the block is in force;
  // muted once the session moved past it, so a stale banner reads as history.
  const tone = !live
    ? { border: "border-sol-border/40 bg-sol-bg-alt/30", fg: "text-sol-text-muted", badge: "border-sol-border/40 bg-sol-bg-alt/50 text-sol-text-muted", icon: "bg-sol-bg-alt text-sol-text-muted" }
    : isServerError
      ? { border: "border-sol-red/40 bg-sol-red/10", fg: "text-sol-red", badge: "border-sol-red/40 bg-sol-red/10 text-sol-red", icon: "bg-sol-red/20 text-sol-red" }
      : { border: "border-amber-500/40 bg-amber-500/10", fg: error.isSafety ? "text-amber-700 dark:text-amber-500" : "text-amber-500", badge: "border-amber-500/40 bg-amber-500/10 text-amber-500", icon: "bg-amber-500/20 text-amber-500" };

  let heading: string;
  let icon: ReactNode;
  let hint: ReactNode;
  const remedy = authRemedy(agentType);
  if (error.isSafety) {
    heading = "Safety review required";
    icon = <span className="text-[10px] font-semibold">!</span>;
    hint = <p className="mt-1.5 text-xs text-sol-text-dim">{SAFETY_BLOCK_HINT}</p>;
  } else if (error.isAuth) {
    heading = "Authentication required";
    icon = (
      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <circle cx="7.5" cy="15.5" r="3.5" />
        <path d="M10 13L20 3M17 6l2 2M14 9l2 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
    hint = (
      <>
        <div className="mt-2 flex items-center gap-1.5 flex-wrap text-xs text-sol-text-dim">
          <span>Run</span>
          <CopyCommand command={remedy.command} />
          <span>{remedy.where} to {remedy.inPane ? "re-authenticate" : "set up an account"}, then retry.</span>
        </div>
        {agentType === "opencode" && (
          <ProviderKeyInlineEntry errorMessage={error.message} conversationId={conversationId} />
        )}
      </>
    );
  } else if (error.isThrottle) {
    heading = "Rate limited";
    icon = (
      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
    hint = (
      <p className="mt-1.5 text-xs text-sol-text-dim">
        A burst of requests hit the account&apos;s per-minute cap, not a usage window — codecast continues throttled
        sessions a few at a time after about a minute. Send{" "}
        <code className="px-1 py-0.5 rounded bg-sol-bg-alt/60 text-sol-text-secondary font-mono">continue</code>{" "}
        to retry now.
      </p>
    );
  } else if (error.isConnection) {
    heading = "Connection dropped";
    icon = (
      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
    hint = (
      <p className="mt-1.5 text-xs text-sol-text-dim">
        The turn was cut off mid-response — send{" "}
        <code className="px-1 py-0.5 rounded bg-sol-bg-alt/60 text-sol-text-secondary font-mono">continue</code>{" "}
        (or any message) and the session picks up where it left off.
      </p>
    );
  } else {
    heading = "API Error";
    icon = <span className="text-[10px] font-semibold">!</span>;
    hint = (
      <p className="mt-1 text-xs text-sol-text-dim">
        {error.isFatal ? (
          <>
            The agent won&apos;t retry this on its own — send{" "}
            <code className="px-1 py-0.5 rounded bg-sol-bg-alt/60 text-sol-text-secondary font-mono">continue</code>{" "}
            (or any message) to retry the turn.
          </>
        ) : (
          "Provider-side failure. Retry the request; if it repeats, include the request ID."
        )}
      </p>
    );
  }

  return (
    <div className={`rounded-lg border ${tone.border} ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full ${tone.icon}`}>
          {icon}
        </span>
        <span className={`text-xs font-semibold uppercase tracking-wide ${tone.fg}`}>
          {heading}
        </span>
        {error.statusCode && !error.isLimit && !error.isConnection && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${tone.badge}`}>
            {error.statusCode}
          </span>
        )}
        {error.errorType && !error.isAuth && !error.isLimit && !error.isConnection && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border/40 bg-sol-bg-alt/50 text-sol-text-dim font-mono">
            {error.errorType}
          </span>
        )}
        {!live && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-green/40 bg-sol-green/10 text-sol-green uppercase tracking-wide">
            resolved
          </span>
        )}
        {timestamp != null && (
          <span className="ml-auto text-[10px] text-sol-text-dim shrink-0 whitespace-nowrap" title={formatFullTimestamp(timestamp)}>
            {formatRelativeTime(timestamp)}
          </span>
        )}
      </div>
      <p className={`mt-1 text-sm ${tone.fg}`}>{error.message}</p>
      {error.requestId && !error.isAuth && !error.isLimit && !error.isConnection && (
        <p className="mt-1 text-[11px] text-sol-text-muted font-mono">
          request_id: <span className="text-sol-text-secondary">{error.requestId}</span>
        </p>
      )}
      {!live ? (
        <p className="mt-1.5 text-xs text-sol-text-dim">
          The session continued after this — nothing to do here.
        </p>
      ) : !compact && hint}
    </div>
  );
}

// Inline key entry on an opencode auth-error card. opencode fails a turn when the
// chosen provider has no key on the machine; rather than send the user to a terminal,
// let them drop the key right here — sealed to the session's owner device and applied
// by its daemon. The key leaves the browser only as ciphertext (encryptProviderKey).
// Collapsed behind an "Add a key" toggle so the amber card stays uncluttered; falls
// back to the `cast keys set` command when the device's daemon predates managed keys.
function ProviderKeyInlineEntry({
  errorMessage,
  conversationId,
}: {
  errorMessage: string;
  conversationId?: string;
}) {
  const [open, setOpen] = useState(false);
  const detected = useMemo(() => detectProviderFromError(errorMessage), [errorMessage]);
  const [provider, setProvider] = useState<string>(detected ?? PROVIDER_KEYS[0].id);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const { byId, mostRecentOnlineLocal } = useDevices();
  const ownerDeviceId = useInboxStore((s) =>
    conversationId ? s.sessions[conversationId]?.owner_device_id : undefined,
  );
  const { setKey } = useProviderKeyCommand();

  // The device running this session, else the primary online machine.
  const device = (ownerDeviceId ? byId.get(ownerDeviceId) : undefined) ?? mostRecentOnlineLocal ?? null;
  const pubkey = device ? deviceManagedKeys(device).pubkey : undefined;
  const spec = getProviderKeySpec(provider);

  const save = async () => {
    const key = value.trim();
    if (!key || !pubkey || !device) return;
    setBusy(true);
    try {
      await setKey(device.device_id, pubkey, provider, key);
      toast.success("Key saved — resend to retry");
      setValue("");
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save that key");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1 text-xs text-amber-500 hover:text-amber-400 transition-colors"
      >
        <KeyRound className="w-3 h-3" />
        Add a key
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 space-y-2">
      {!device ? (
        <p className="text-xs text-sol-text-dim">
          No online machine to store a key on. Start your daemon, then try again.
        </p>
      ) : !pubkey ? (
        <div className="flex items-center gap-1.5 flex-wrap text-xs text-sol-text-dim">
          <span>This machine&apos;s daemon predates managed keys — set it from a terminal:</span>
          <CopyCommand command={`cast keys set ${provider}`} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="rounded border border-sol-border bg-sol-bg px-2 py-1 text-xs text-sol-text focus:border-sol-cyan focus:outline-none"
            >
              {PROVIDER_KEYS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            {spec && (
              <a
                href={spec.consoleUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-cyan"
              >
                get a key
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") { setOpen(false); setValue(""); }
              }}
              placeholder={spec?.keyPrefix ? `${spec.keyPrefix}…` : "API key"}
              className="flex-1 min-w-0 rounded border border-sol-border bg-sol-bg px-2 py-1 text-xs text-sol-text font-mono placeholder:text-sol-base01 focus:border-sol-cyan focus:outline-none"
            />
            <button
              onClick={save}
              disabled={busy || !value.trim()}
              className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-500 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Save &amp; retry
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ConversationMetadata({
  agentType,
  model,
  effort,
  startedAt,
  messageCount,
  shortId,
  conversationId,
  canEditModel,
  controlOpen,
  onControlOpenChange,
}: {
  agentType?: string;
  model?: string;
  effort?: string;
  startedAt?: number;
  messageCount?: number;
  shortId?: string;
  conversationId?: string;
  canEditModel?: boolean;
  /** The session control panel's open state, shared with the overflow menu. */
  controlOpen?: boolean;
  onControlOpenChange?: (open: boolean) => void;
}) {
  const live = useLiveSessionMeta(conversationId);
  const resolvedAgent = live?.agentType ?? agentType;
  const resolvedModel = live ? (live.model ?? undefined) : model;
  if (!resolvedAgent && !resolvedModel && !startedAt && !messageCount) return null;

  return (
    // flex-shrink-0: this cluster must overflow, not clip, so the header's
    // squeeze measurement sees it and sheds its parts tier by tier.
    <div className="flex items-center gap-1 text-[10px] sm:text-xs text-sol-text-dim flex-shrink-0">
      {resolvedAgent && (
        <div
          className="flex items-center flex-shrink-0 cursor-default"
          title={formatAgentType(resolvedAgent)}
        >
          <AgentTypeIcon agentType={resolvedAgent} />
        </div>
      )}
      <HeaderModelControl
        conversationId={conversationId}
        agentType={resolvedAgent}
        model={resolvedModel}
        effort={live ? (live.effort ?? undefined) : effort}
        messageCount={messageCount}
        canEdit={!!canEditModel}
        open={controlOpen}
        onOpenChange={onControlOpenChange}
      />
      {startedAt && (
        <div className="flex items-center gap-1.5 flex-shrink-0 cq-sq2">
          <span className="text-sol-text-dim">&middot;</span>
          <span title={formatFullTimestamp(startedAt)}>{formatRelativeTime(startedAt)}</span>
        </div>
      )}
      {messageCount !== undefined && messageCount > 0 && (
        <button
          className="hidden sm:flex items-center gap-1.5 flex-shrink-0 hover:text-sol-text-muted transition-colors cursor-pointer cq-sq1"
          title="Copy conversation ID"
          onClick={() => { if (conversationId) setTimeout(() => { copyToClipboard(conversationId).then(() => toast.success("ID copied")); }); }}
        >
          <span className="text-sol-text-dim">&middot;</span>
          <span>{messageCount} {messageCount === 1 ? "msg" : "msgs"}</span>
        </button>
      )}
      {startedAt && (
        <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0 cq-sq1">
          <span className="text-sol-text-dim">&middot;</span>
          <span>{formatDuration(startedAt)}</span>
        </div>
      )}
    </div>
  );
}

const INLINE_TASK_STATUS: Record<string, { icon: typeof Circle; color: string }> = {
  open: { icon: Circle, color: "text-sol-blue" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
};

function TaskProgressRow({ taskStats }: { taskStats: { total: number; done: number; in_progress: number; open: number; items: { id: string; content: string; status: string }[] } }) {
  const [expanded, setExpanded] = useState(false);
  const { total, done, in_progress } = taskStats;
  const donePct = (done / total) * 100;
  const ipPct = (in_progress / total) * 100;
  const isComplete = done === total;

  return (
    <div className="mt-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-1 py-0.5 rounded hover:bg-sol-bg-alt/60 transition-colors group cursor-pointer"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-sol-text-dim flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-sol-text-dim flex-shrink-0" />}
        {isComplete ? (
          <CheckCircle2 className="w-3 h-3 text-sol-green flex-shrink-0" />
        ) : in_progress > 0 ? (
          <CircleDot className="w-3 h-3 text-sol-yellow animate-pulse flex-shrink-0" />
        ) : (
          <Circle className="w-3 h-3 text-sol-text-dim flex-shrink-0" />
        )}
        <div className="flex-1 h-1.5 bg-sol-border/30 rounded-full overflow-hidden min-w-[60px] max-w-[120px]">
          <div className="h-full flex">
            <div
              className={`h-full ${isComplete ? "bg-sol-green" : "bg-sol-green/80"}`}
              style={{ width: `${donePct}%` }}
            />
            {ipPct > 0 && (
              <div className="h-full bg-sol-yellow/60" style={{ width: `${ipPct}%` }} />
            )}
          </div>
        </div>
        <span className={`text-[10px] tabular-nums flex-shrink-0 ${isComplete ? "text-sol-green" : "text-sol-text-dim"}`}>
          {done}/{total} tasks
        </span>
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 border-l border-sol-border/20 pl-2">
          {taskStats.items.map((item) => {
            const cfg = INLINE_TASK_STATUS[item.status] || INLINE_TASK_STATUS.open;
            const Icon = cfg.icon;
            return (
              <div key={item.id} className="flex items-center gap-1.5 py-0.5">
                <Icon className={`w-3 h-3 flex-shrink-0 ${cfg.color}`} />
                <span className={`text-[11px] truncate ${item.status === "done" ? "text-sol-text-dim line-through" : "text-sol-text-muted"}`}>
                  {item.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Task stats live in their own leaves so a streaming TodoWrite re-renders
// only these tiny consumers instead of the 11k-line ConversationView. Derived
// from the messages already in the store — a live getConversationToolStats
// scan of assistant tool_calls times out on long sessions ("too many system
// operations") and used to ErrorBoundary the Questions header.
function useConversationTaskStats(conversationId: string | undefined) {
  const messages = useInboxStore((s) =>
    conversationId ? s.messages[conversationId] : undefined,
  );
  return useMemo(() => computeConversationTaskStats(messages), [messages]);
}

// Full-width strip at the header's bottom edge narrating a kill+restart the
// moment it's requested — before any server ack — through the daemon's
// kill→resume ladder, to a green "back live" confirmation or a red give-up.
// Driven entirely by useSessionRestart's phase/stage; mounted only while a
// restart is in some visible state, so the 1s elapsed tick costs nothing
// otherwise.
export function RestartStatusStrip({ phase, stage, failure, startedAt, onRetry, restoredLabel }: {
  phase: RestartPhase;
  stage: RestartStage | null;
  failure: string | null;
  startedAt: number | null;
  onRetry: () => void;
  /** "Back live" confirmation text — device moves say where the session landed. */
  restoredLabel?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useWatchEffect(() => {
    if (phase !== "restarting") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);
  if (phase === "idle") return null;
  const tone = phase === "restored" ? "ok" : phase === "failed" ? "error" : (stage?.tone ?? "active");
  const label =
    phase === "restored" ? (restoredLabel ?? "Session is back live")
    : phase === "failed" ? (failure ?? "Restart failed")
    : (stage?.label ?? "Restarting session — contacting daemon…");
  const toneClass = {
    active: { wrap: "bg-sol-orange/10 text-sol-orange", dot: "bg-sol-orange" },
    warn: { wrap: "bg-sol-yellow/10 text-sol-yellow", dot: "bg-sol-yellow" },
    error: { wrap: "bg-sol-red/10 text-sol-red", dot: "bg-sol-red" },
    ok: { wrap: "bg-sol-green/10 text-sol-green", dot: "bg-sol-green" },
  }[tone];
  const elapsed = phase === "restarting" && startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : null;
  return (
    <div className={`flex items-center gap-2 px-4 py-1.5 text-[12px] ${toneClass.wrap}`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${toneClass.dot} ${tone === "error" ? "" : "animate-pulse"}`} />
      <span className="min-w-0 truncate">{label}</span>
      {elapsed !== null && elapsed >= 3 && (
        <span className="shrink-0 tabular-nums opacity-60">{elapsed}s</span>
      )}
      {phase === "failed" && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 ml-auto font-medium hover:underline"
        >
          Try again
        </button>
      )}
    </div>
  );
}

// Same strip for a device move ("Run here" / "Move to remote Mac"): the move
// pipeline — worktree transfer, resume on the destination — narrated live from
// the same daemon command rows. useDeviceMoveStatus owns the lifecycle
// (movingSessions in the store), so this stays mounted-cheap when idle.
export function DeviceMoveStatusStrip({ conversationId }: { conversationId: string }) {
  const { phase, stage, failure, startedAt, restoredLabel, retry } = useDeviceMoveStatus(conversationId);
  return (
    <RestartStatusStrip
      phase={phase}
      stage={stage}
      failure={failure}
      startedAt={startedAt}
      onRetry={retry}
      restoredLabel={restoredLabel}
    />
  );
}

export const ConversationTaskProgress = memo(function ConversationTaskProgress({ conversationId }: { conversationId: string }) {
  const taskStats = useConversationTaskStats(conversationId);
  if (!taskStats) return null;
  return <TaskProgressRow taskStats={taskStats} />;
});

export const ConversationTaskStatsMenuItem = memo(function ConversationTaskStatsMenuItem({ conversationId }: { conversationId: string }) {
  const taskStats = useConversationTaskStats(conversationId);
  if (!taskStats) return null;
  return (
    <DropdownMenuItem disabled>
      Tasks: {taskStats.done}/{taskStats.total}
    </DropdownMenuItem>
  );
});

// The composer-footer "working" status line. A working turn can go quiet for
// minutes — one long generation, or a long-running tool whose result hasn't
// landed yet — and a static "Working" reads as frozen. Past a short grace, surface
// a live-ticking elapsed clock (and the tool in flight, if any) so a long turn
// visibly reads as progressing. startedAt = last rendered message timestamp (how
// long the view has been static); phrase = what the loaded timeline says is in
// flight ("editing chat.ts"), the fallback when the row's server side activity
// stamp (the same phrase, written at ingest and shown on the inbox card) is
// absent or stale. Owns its own 1s ticker so only this tiny node re-renders each
// second, not the whole composer; the activity dep is per row, text plus stamp.
export function WorkingStatusLine({ startedAt, phrase, conversationId }: { startedAt?: number; phrase?: string; conversationId: string }) {
  const [now, setNow] = useState(() => Date.now());
  useMountEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  });
  const st = useTrackedStore([(s) => activitySig(s.sessions[conversationId]?.activity)]);
  const rowActivity = st.sessions[conversationId]?.activity;
  // This line renders only while the turn is working, so the work state half
  // of the shared rule is already true here.
  const label = isSessionActivityFresh(rowActivity, "working", now) ? rowActivity.text : phrase;
  const elapsedMs = startedAt ? now - startedAt : 0;
  const showElapsed = shouldShowElapsed(startedAt, now);
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <LivePulseDot className="w-2 h-2" />
      Working
      {showElapsed && <span className="text-sol-text-dim/60 tabular-nums">· {formatElapsedClock(elapsedMs)}</span>}
      {showElapsed && label && <span className="text-sol-text-dim/60 truncate" title={label}>· {label}</span>}
    </span>
  );
}
