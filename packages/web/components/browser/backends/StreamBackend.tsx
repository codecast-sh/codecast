"use client";
// The tab an agent is driving, as a pane on the stage.
//
// The transport, the frame and the control surface are BrowserStream's; this
// file is the part that only makes sense inside a pane: it turns the route's
// session uuid into a conversation and the machine that conversation runs on,
// it puts the stream's own verbs (drive, reconnect, raise the real tab) in the
// pane's address strip, and it translates the stream's status into the states
// the pane already knows how to paint.
//
// Which machine matters more here than anywhere else. A watch pane persists
// with its tab, so it can be restored on a different machine from the one that
// drove the browser — and a stream only exists on the machine whose daemon
// owns the tab. Saying WHICH machine, and whose, is the difference between a
// pane that looks broken and one that tells you where to open it.

import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowUpRight, MousePointerClick, RotateCw } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useInboxStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { deviceDisplayName } from "../../DeviceBadge";
import type { SessionMachine } from "../../tmuxAttach";
import { missingTabMessage, type BrowserStreamReport } from "../../../lib/browserWatch";
import { BrowserStream } from "../BrowserStream";
import { useBrowserTabActions } from "../../../hooks/useBrowserTabActions";
import type { BackendProps, PaneStripAction } from "./types";

export function StreamBackend({
  source,
  focused,
  reloadToken,
  onTitle,
  onUrl,
  onState,
  onActions,
}: BackendProps) {
  const sessionUuid = source.kind === "watch" ? source.sessionUuid : "";

  // The route names the session by its uuid; everything else about it is
  // already in the store, so this is a read, not another subscription. A
  // scalar signature keeps the churny sessions collection from re-rendering
  // the pane three times a second for fields it does not show.
  const session = useInboxStore(
    useShallow((s) => {
      const row = sessionUuid
        ? (s.sessions[sessionUuid] ?? Object.values(s.sessions).find((r) => r.session_id === sessionUuid))
        : undefined;
      return {
        convId: row?._id ?? null,
        tmuxSession: row?.tmux_session ?? null,
        title: row?.title ?? null,
      };
    }),
  );

  // Enrichment, so useQueryNoThrow (the header-outage rule): without an answer
  // we still try local discovery, which is right on a one-machine setup.
  const machineQuery = useQueryNoThrow(
    api.devices.getConversationMachine,
    session.convId ? ({ conversation_id: session.convId as any } as any) : "skip",
  );
  const machine = machineQuery.data as SessionMachine | null | undefined;
  // A session the store has never heard of has no conversation to ask about;
  // that is settled too, and the local daemon is the honest thing to try.
  const machineSettled = !session.convId || machine !== undefined || !!machineQuery.error;
  const machineName = machine ? deviceDisplayName(machine as any) : null;

  const [report, setReport] = useState<BrowserStreamReport>({
    status: { kind: "connecting" },
    tab: null,
    controlAvailable: false,
    hasFrame: false,
    nav: null,
  });
  const [control, setControl] = useState(false);
  const [retry, setRetry] = useState(0);
  const redial = useCallback(() => setRetry((n) => n + 1), []);

  const status = report.status;
  const failed = status.kind === "failed" ? status : null;
  const tabUrl = report.tab?.url ?? null;
  const tabActions = useBrowserTabActions(
    { tabId: report.tab?.id ?? null, url: tabUrl },
    { sessionUuid, tmuxSession: session.tmuxSession },
    redial,
  );

  // The pane paints the states; this is the translation. A stream that failed
  // is an `error` with the sentence already written (lib/browserWatch), except
  // for the one case the pane can say better than the daemon: no tab at all,
  // which is about a session and its last page, not about a socket.
  const paneState = useMemo(() => {
    if (!failed) {
      return status.kind === "connecting"
        ? ({ kind: "loading" } as const)
        : // Not opaque: unlike a cross-origin frame, the stream knows exactly
          // what it is showing — the daemon names the tab.
          ({ kind: "ready", opaque: false } as const);
    }
    const message =
      failed.tabGone && !failed.capped
        ? missingTabMessage(session.title, tabUrl)
        : failed.message;
    return { kind: "error", message } as const;
  }, [failed, status.kind, session.title, tabUrl]);

  useWatchEffect(() => onState(paneState), [paneState, onState]);

  // The strip's verbs. The wheel is the one people come here for, so it keeps
  // the pane's `is-on` treatment; the others are the plain panel buttons.
  const live = status.kind === "live";
  const offerReopen = !!failed?.tabGone && !!tabUrl;
  const busy = tabActions.state.kind === "busy";
  useWatchEffect(() => {
    if (!onActions) return;
    const actions: PaneStripAction[] = [];
    if (live && report.controlAvailable) {
      actions.push({
        icon: <MousePointerClick className="w-3 h-3" />,
        label: control
          ? "Hand the page back to the agent (Esc)"
          : "Take the wheel: your clicks and typing go to this page",
        active: control,
        onClick: () => setControl((v) => !v),
      });
    }
    actions.push({
      icon: <RotateCw className="w-3 h-3" />,
      label: failed?.capped ? "Resume the stream" : "Reconnect the stream",
      onClick: redial,
    });
    if (offerReopen || tabActions.tabId) {
      actions.push({
        icon: <ArrowUpRight className="w-3.5 h-3.5" />,
        label: offerReopen
          ? `Reopen ${tabUrl} in the agent's browser`
          : "Raise this tab in the agent's browser",
        active: busy,
        onClick: offerReopen ? tabActions.reopen : tabActions.focus,
      });
    }
    onActions(actions);
    // The backend owns its verbs, so it takes them away too. The pane cannot:
    // a child's effects run before its parent's, so a reset in the pane on
    // mount would wipe the first set this effect just registered.
    return () => onActions([]);
  }, [
    onActions,
    live,
    report.controlAvailable,
    control,
    failed?.capped,
    offerReopen,
    tabUrl,
    tabActions.tabId,
    busy,
    redial,
  ]);

  return (
    <div className="absolute inset-0 bg-sol-bg-inset">
      {status.kind !== "live" && !failed && !report.hasFrame && <ViewportSkeleton />}
      <BrowserStream
        sessionUuid={sessionUuid}
        tmuxSession={session.tmuxSession}
        machine={machine ?? null}
        machineSettled={machineSettled}
        paneActive={focused}
        control={control}
        reloadToken={reloadToken + retry}
        onState={setReport}
        onTitle={onTitle}
        onUrl={onUrl}
        onReleaseControl={() => setControl(false)}
      />
      {live && (
        <span
          className="absolute top-2 left-2 inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-full bg-sol-bg/75 border border-sol-border/40 text-[9px] font-mono tracking-wider text-sol-text-dim backdrop-blur-sm"
          title={
            machineName
              ? `Streaming from ${machineName}, the machine this agent's browser runs on`
              : "Streaming from the machine this agent's browser runs on"
          }
        >
          <span className="w-1.5 h-1.5 rounded-full bg-sol-red animate-pulse motion-reduce:animate-none" />
          <span className="text-sol-red">LIVE</span>
          {machineName && <span className="max-w-[120px] truncate">{machineName}</span>}
        </span>
      )}
      {tabActions.state.kind === "note" && (
        <span className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded bg-sol-bg/85 border border-sol-red/30 text-[10px] font-mono text-sol-red/80">
          {tabActions.state.text}
        </span>
      )}
    </div>
  );
}

/**
 * What a browser looks like before the first frame: the shape of the thing
 * being dialed, not a spinner. A screencast opens in about a second, and a
 * spinner for one second reads as an error starting; an empty viewport reads
 * as a browser about to show something, which is what is true.
 */
function ViewportSkeleton() {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="w-full max-w-[520px] rounded-md border border-sol-border/40 overflow-hidden animate-pulse motion-reduce:animate-none">
        <div className="flex items-center gap-1.5 h-6 px-2 bg-sol-bg-alt/40 border-b border-sol-border/30">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/30" />
          <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/30" />
          <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/30" />
          <span className="ml-1.5 h-2 flex-1 max-w-[180px] rounded bg-sol-text-dim/15" />
        </div>
        <div className="p-3 flex flex-col gap-2 bg-sol-bg-alt/20">
          <span className="h-2.5 w-1/3 rounded bg-sol-text-dim/15" />
          <span className="h-2 w-4/5 rounded bg-sol-text-dim/10" />
          <span className="h-2 w-2/3 rounded bg-sol-text-dim/10" />
          <span className="h-16 w-full rounded bg-sol-text-dim/[0.07]" />
        </div>
      </div>
    </div>
  );
}
