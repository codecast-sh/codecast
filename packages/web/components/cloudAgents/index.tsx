"use client";

// The cloud agent controls every surface renders: the setup text and held
// note on a setup card, the connect button, the Provider Keys sign-in rows,
// the Sync switch notes, and the session's cloud agent chip and menu rows.
// What they read lives beside them: the provider registry (providerUi.ts),
// the driving machine and its status (machine.ts), whether it holds the
// credential (credentials.ts) and the session's agent and actions
// (sessionAgent.ts). A new provider is an entry in the shared registry and
// providerUi.ts, not new JSX.

import { useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { CLOUD_AGENT_ACTIONS, CLOUD_AGENT_PROVIDERS, CLOUD_AGENT_RETRIED_SUFFIX, cloudAgentOtherLanes, cloudAgentProviderForSyncSource, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { useLiveSessionMeta } from "../../hooks/useLiveSessionMeta";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { useInboxStore } from "../../store/inboxStore";
import { convHasPendingSend } from "../../store/inboxOverlays";
import { cloudAgentUi } from "./providerUi";
import { useCloudAgentStatus } from "./machine";
import { moveHeldToLane } from "./lanes";
import { CloudAgentRepoAccessLink } from "./parts";
import type { CloudAgentActions, CloudAgentSetupCard } from "./sessionAgent";
import { heldSendsOf } from "../../lib/pendingBanner";

/** What waits on a setup problem that is not a credential. */
const UNTIL_FIXED = "this is fixed";

/**
 * A setup card's sentence (cloudAgentCardKind "setup") without the retry clause the
 * card's own line says, and the page it names where access is given as a
 * named link.
 */
export function CloudAgentSetupText({ spec, message }: { spec: CloudAgentProviderSpec; message: string }) {
  const text = message.trim().replace(CLOUD_AGENT_RETRIED_SUFFIX, ".");
  const at = text.indexOf(spec.repoAccessUrl);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <CloudAgentRepoAccessLink spec={spec} />
      {text.slice(at + spec.repoAccessUrl.length)}
    </>
  );
}

/** The violet pill a setup card's and a settings row's controls share. */
function CardButton({ onClick, title, disabled, className, children }: { onClick: () => void; title?: string; disabled?: boolean; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded border border-sol-violet/40 bg-sol-violet/10 px-1.5 py-0.5 text-[10px] font-medium text-sol-violet transition-colors hover:bg-sol-violet/20 disabled:opacity-60 ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

/**
 * Under a setup card: for a credential card, the connect button, or once the
 * credential is there, that it is; while a message is held (`live`: the card
 * is still the session's latest word), starting it on the vendor's other lane
 * instead; and what the held message waits for.
 */
export function CloudAgentSetupHint({ card, conversationId, live }: { card: CloudAgentSetupCard; conversationId?: string; live: boolean }) {
  const { spec, kind } = card;
  const credential = kind === "credential";
  if (card.resolved) return <p className="mt-1.5 text-xs text-sol-text-dim">{cloudAgentUi(spec).connectName} is connected on {card.machine} now.</p>;
  return (
    <div className="mt-1.5 flex items-center gap-2 flex-wrap text-xs text-sol-text-dim">
      {credential && <ConnectCloudAgentButton spec={spec} conversationId={conversationId} />}
      {live && <CloudAgentLaneSwitch spec={spec} conversationId={conversationId} />}
      <span><CloudAgentHeldNote spec={spec} credential={credential} machine={card.machine} conversationId={conversationId} /></span>
    </div>
  );
}

/**
 * A setup card's line on the message it stopped (`credential`: a credential
 * card), saying what it waits for on the machine that runs the session: held
 * and going out on its own, or, once nothing is held (it was cancelled), to
 * send again then.
 */
function CloudAgentHeldNote({ spec, credential, machine, conversationId }: { spec: CloudAgentProviderSpec; credential: boolean; machine: string; conversationId?: string }) {
  // Sent from this window, or held on the server whichever surface sent it (a CLI spawn, another tab).
  const held = useInboxStore((s) => !!conversationId && (convHasPendingSend(s.pendingMessages[conversationId]) || heldSendsOf(s, conversationId).length > 0));
  const until = credential ? cloudAgentUi(spec).heldUntil(machine) : UNTIL_FIXED;
  return held ? <>Your message is held and goes out on its own as soon as {until}.</> : <>Nothing is held now: send your message again once {until}.</>;
}

/**
 * While the message is held: start it on the vendor's other lane instead
 * (the Agents API cannot clone a private repository and needs a paid key;
 * Codex Cloud on the ChatGPT plan can and does not, and back). The held
 * message moves to a new session there, in the same folder and from the same
 * machine.
 */
function CloudAgentLaneSwitch({ spec, conversationId }: { spec: CloudAgentProviderSpec; conversationId?: string }) {
  const held = useInboxStore((s) => heldSendsOf(s, conversationId).length > 0);
  const [moving, setMoving] = useState(false);
  if (!conversationId || !held) return null;
  return (
    <>
      {cloudAgentOtherLanes(spec).map((lane) => (
        <CardButton
          key={lane.id}
          disabled={moving}
          onClick={() => { setMoving(true); void moveHeldToLane(conversationId, lane).finally(() => setMoving(false)); }}
          title={`${lane.label}: ${lane.lane!.detail}`}
        >
          {moving && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          Start on {lane.lane!.label} instead
        </CardButton>
      ))}
    </>
  );
}

/** A small control that opens the provider's connect dialog. */
export function ConnectCloudAgentButton({ spec, label, className, deviceId, conversationId }: { spec: CloudAgentProviderSpec; label?: string; className?: string; deviceId?: string | null; conversationId?: string }) {
  const [open, setOpen] = useState(false);
  // From a session: the credentials belong on the machine that runs it.
  const ownerDeviceId = useLiveSessionMeta(conversationId)?.ownerDeviceId;
  const { Dialog, connectLabel } = cloudAgentUi(spec);
  return (
    <>
      <CardButton onClick={() => setOpen(true)} className={className}>
        <KeyRound className="h-3 w-3" aria-hidden />
        {label ?? connectLabel}
      </CardButton>
      {open && <Dialog deviceId={deviceId ?? ownerDeviceId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The sign-in based providers, listed with the Provider Keys: each one's state on the machine and its connect dialog. */
export function CloudAgentSignInRows({ deviceId }: { deviceId: string }) {
  return <>{Object.values(CLOUD_AGENT_PROVIDERS).filter((spec) => cloudAgentUi(spec).signIn).map((spec) => <CloudAgentSignInRow key={spec.id} spec={spec} deviceId={deviceId} />)}</>;
}

function CloudAgentSignInRow({ spec, deviceId }: { spec: CloudAgentProviderSpec; deviceId: string }) {
  const { connected, problem } = useCloudAgentStatus(spec, deviceId);
  const { connectName, signIn } = cloudAgentUi(spec);
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3.5 sm:flex-nowrap sm:px-5">
      <div className="min-w-0">
        <span className="text-sm text-sol-text">{spec.label}</span>
        <p className="mt-0.5 text-xs text-sol-text-muted">{signIn}</p>
        {/* No sign-in at all is what the Connect button says. */}
        {problem && problem.kind !== "key_missing" && <p className="mt-0.5 text-xs text-amber-500">{problem.sentence}</p>}
      </div>
      <ConnectCloudAgentButton spec={spec} deviceId={deviceId} label={connected ? `${connectName} connected` : undefined} />
    </div>
  );
}

/**
 * Under an account sync switch whose provider your computer cannot read: no
 * sign-in (said only while the switch is on), a sign-in that ran out or is
 * refused, or the provider refusing the account (Codex Cloud turned off for
 * the workspace). Nothing syncs until that changes.
 */
export function CloudAgentSyncNote({ source, on }: { source: string; on: boolean }) {
  const spec = cloudAgentProviderForSyncSource(source) ?? undefined;
  const { problem } = useCloudAgentStatus(spec);
  if (!spec || !problem || (problem.kind === "key_missing" && !on)) return null;
  // Beside the connect control: a credential problem is fixed by using it.
  return <span className="mt-1 block text-amber-500">{problem.sentence} Nothing syncs until {problem.credential ? `you ${cloudAgentUi(spec).connectInlineLabel}` : UNTIL_FIXED}.</span>;
}

/** Beside an account sync switch whose source is a cloud agent provider: its connect dialog, saying whether your computer is connected. */
export function CloudAgentSyncConnect({ source }: { source: string }) {
  const spec = cloudAgentProviderForSyncSource(source) ?? undefined;
  const { connected } = useCloudAgentStatus(spec);
  if (!spec) return null;
  return <ConnectCloudAgentButton spec={spec} label={connected ? `${cloudAgentUi(spec).connectName} connected` : undefined} />;
}

/** The provider's page for a session's agent, and where it opens; null when the provider has no page per agent. */
function agentPage(spec: CloudAgentProviderSpec, agentId: string): { href: string; host: string } | null {
  const href = spec.agentUrl?.(agentId);
  return href ? { href, host: new URL(href).host } : null;
}

/**
 * How ActionRows sit in their menu: the chip's own menu, compact and in the
 * provider's color, or the session menu, where they read like its other rows.
 */
const ROW_STYLES = {
  chip: { item: "gap-2 text-xs", icon: "h-3.5 w-3.5 text-sol-violet" },
  menu: { item: "", icon: "h-3 w-3 mr-1.5" },
} as const;

/**
 * A menu's rows for a cloud agent: open it on the provider's site, then the
 * owner's actions on it. A disabled action says why in the row itself (a
 * disabled row takes no hover, so a tooltip would never show).
 */
function ActionRows({ actions, style }: { actions: CloudAgentActions; style: keyof typeof ROW_STYLES }) {
  const { cloud, items, run, pending } = actions;
  if (!cloud?.agentId) return null;
  const page = agentPage(cloud.spec, cloud.agentId);
  const row = ROW_STYLES[style];
  return (
    <>
      {page && (
        <DropdownMenuItem onSelect={() => window.open(page.href, "_blank", "noopener")} className={row.item}>
          <ExternalLink className={row.icon} />
          Open on {page.host}
        </DropdownMenuItem>
      )}
      {items.map(({ action, label, title, Icon, disabledReason }) => (
        <DropdownMenuItem key={action} disabled={!!pending || !!disabledReason} onSelect={() => void run(action)} title={title} className={`items-start ${row.item}`}>
          {pending === action ? <Loader2 className={`mt-px shrink-0 animate-spin ${row.icon}`} /> : <Icon className={`mt-px shrink-0 ${row.icon}`} />}
          <span className="flex min-w-0 flex-col">
            {label}
            {disabledReason && <span className="text-[10px] text-sol-text-dim">{disabledReason}</span>}
          </span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** The session menu's rows for a cloud agent session (ActionRows under the provider's name). Nothing for a local session, or for an agent with no page and no actions. */
export function CloudAgentMenuItems({ actions }: { actions: CloudAgentActions }) {
  if (!actions.cloud?.agentId || (!actions.cloud.spec.agentUrl && !actions.items.length)) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">{actions.cloud.spec.label}</DropdownMenuLabel>
      <ActionRows actions={actions} style="menu" />
    </>
  );
}

const CHIP = "inline-flex shrink-0 items-center gap-1 rounded border border-sol-violet/30 px-1.5 py-px text-[10px] text-sol-violet";

/**
 * The cloud agent behind a session: a link to it on the provider's site, or
 * for its owner, a menu with that link and the provider's actions on it.
 * Before the agent exists, only the provider's name.
 */
export function CloudAgentLink({ actions }: { actions: CloudAgentActions }) {
  const { cloud, items, pending } = actions;
  if (!cloud) return null;
  const { spec, agentId } = cloud;
  const name = (
    <>
      {/* A phone's header strip is short: the provider's mark says which cloud. */}
      <AgentTypeIcon agentType={spec.agentType} className="h-2.5 w-2.5 sm:hidden" />
      <span className="sm:hidden">Cloud</span>
      <span className="hidden sm:inline">{spec.label}</span>
    </>
  );
  if (!agentId) {
    return <span title={`This session runs on ${spec.label}: its agent starts when the first message goes out`} className={CHIP}>{name}</span>;
  }
  const page = agentPage(spec, agentId);
  if (!items.length) {
    if (!page) return <span title={`${spec.label} runs this session. ${spec.vendor} has no page for a single session, so there is nothing to open.`} className={CHIP}>{name}</span>;
    return (
      <a href={page.href} target="_blank" rel="noreferrer" title={`This session runs as a ${spec.label} agent: open it on ${page.host}`} className={`${CHIP} hover:bg-sol-violet/10`}>
        {name}
        <ExternalLink className="h-2.5 w-2.5" aria-hidden />
      </a>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title={pending ? `${CLOUD_AGENT_ACTIONS[pending].label}…` : `This session runs as a ${spec.label} agent: open it, or act on it`} className={`${CHIP} hover:bg-sol-violet/10`}>
          {name}
          {pending ? <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden /> : <ChevronDown className="h-2.5 w-2.5" aria-hidden />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        <ActionRows actions={actions} style="chip" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
