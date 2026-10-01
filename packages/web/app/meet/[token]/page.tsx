"use client";

import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useAction, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { CALL_HEARTBEAT_MS, humanizeConvexError, type CallGuestView, type GuestLinkRefusal } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { AppLoader } from "../../../components/AppLoader";
import { GuestCall, GuestPreview } from "../../../lib/calls/guestRoom";
import { GuestLobby, type LobbyMode } from "./GuestLobby";
import { GuestInCall } from "./GuestInCall";
import { GuestOutcome, type Outcome } from "./GuestOutcome";
import { MeetShell, meetingTitle } from "./MeetChrome";
import {
  clearCreds,
  readCreds,
  readMediaPrefs,
  readName,
  writeCreds,
  writeMediaPrefs,
  writeName,
  type GuestCreds,
} from "./meetStorage";
import "../meet.css";

/**
 * /meet/<token>: a person from outside the team joins a call from a link.
 *
 * Reached with no account, so it boots standalone like the share pages
 * (main.tsx -> src/shareBoot.tsx): no auth provider, no store, no app shell,
 * and nothing that could put an auth wall or an inbox redirect in front of a
 * stranger. It never hands off to the desktop app either (desktopHandoff
 * HANDOFF_DENY): the app on this machine, if there is one, is signed in as
 * somebody else.
 *
 * The SERVER decides where the guest stands (callGuests.getGuestState's
 * `view`), reactively; this page draws that and adds only what the server
 * cannot know: whether this tab is connected to the media, and whether the
 * guest has touched the page (a browser plays no sound for a page nobody
 * touched, so a reload while admitted asks for one press to rejoin).
 *
 *   no secret yet        the lobby: preview, name, notice, Ask to join
 *   waiting              the lobby's door: the room has been asked
 *   admitted             the call (GuestInCall), or one press to rejoin
 *   denied / removed /
 *   left / ended /
 *   closed               what happened, and what they can do (GuestOutcome)
 *
 * The page beats (guestHeartbeat) while it is at the door or inside, which is
 * the guest's lease: a closed tab drops off the door, and an admitted guest
 * whose page went quiet is let go by the server (and a reload inside that
 * window walks straight back in). Closing the tab hangs up the media at once
 * (LiveKit disconnects on page leave); it does not mark them left, so a
 * reload is a blink and not a second knock.
 */

type Describe =
  | {
      ok: true;
      title: string | null;
      inviter: { name: string | null; image?: string | null };
      expires_at: number;
      live: boolean;
      transcribed: boolean;
      recording: boolean;
    }
  | { ok: false; reason: GuestLinkRefusal };

type GuestState = {
  view: CallGuestView;
  name: string;
  left_reason: string | null;
  retry_at: number | null;
  link_open: boolean;
  room: null | {
    title: string | null;
    inviter: { name: string | null; image?: string | null };
    live: boolean;
    transcribed: boolean;
    recording: boolean;
  };
};

/** Has the guest touched this page (a click, a key)? Without it the browser
 *  holds the call's sound. Older browsers without the API answer yes and let
 *  the in-call "turn on sound" line catch the rare block. */
function pageWasTouched(): boolean {
  const ua = (navigator as any).userActivation;
  return ua ? !!ua.hasBeenActive : true;
}

export default function GuestMeetPage() {
  const token = useParams().token as string;
  const [creds, setCreds] = useState<GuestCreds | null>(() => readCreds(token));
  const describe = useQueryNoThrow(api.callGuests.describeGuestLink, { token });
  const guest = useQueryNoThrow(api.callGuests.getGuestState, creds ?? "skip");
  const link = describe.data as Describe | undefined;
  const state = guest.data as GuestState | null | undefined;

  const requestJoin = useMutation(api.callGuests.requestJoin);
  const heartbeat = useMutation(api.callGuests.guestHeartbeat);
  const leaveCall = useMutation(api.callGuests.leaveCall);
  const mintToken = useAction(api.callGuests.mintGuestToken);

  const [name, setName] = useState(readName);
  const [prefs, setPrefs] = useState(readMediaPrefs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stopped asking, from the door: back to the lobby rather than "you left".
  const [backToLobby, setBackToLobby] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [call, setCall] = useState<GuestCall | null>(null);
  const joining = useRef(false);

  // A secret the server no longer knows (a cleared database, a hand-edited
  // store): forget it and start at the lobby.
  useWatchEffect(() => {
    if (creds && state === null) {
      clearCreds(token);
      setCreds(null);
    }
  }, [creds, state, token]);

  const view: CallGuestView | null = state?.view ?? null;
  const atDoorOrIn = view === "waiting" || view === "admitted";

  // The lease: every CALL_HEARTBEAT_MS while at the door or inside, and at
  // once when the tab comes back to the front (a backgrounded tab's timers
  // are throttled, and a guest returning to it should not find themselves let
  // go for it).
  useWatchEffect(() => {
    if (!creds || !atDoorOrIn) return;
    const beat = () => void heartbeat(creds).catch(() => {});
    beat();
    const t = setInterval(beat, CALL_HEARTBEAT_MS);
    const onVisible = () => document.visibilityState === "visible" && beat();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [creds?.guest_id, creds?.secret, atDoorOrIn]);

  useWatchEffect(() => {
    if (view === "waiting") setWaitingSince((s) => s ?? Date.now());
    else setWaitingSince(null);
    if (view === "waiting" || view === "admitted") setBackToLobby(false);
  }, [view]);

  // The preview lives while the guest is choosing, knocking, or about to
  // walk in, and its camera turns off the moment they are anywhere else.
  const lobbyShown = !call && (!creds || atDoorOrIn || backToLobby) && (link?.ok ?? false);
  const [preview, setPreview] = useState<GuestPreview | null>(null);
  useWatchEffect(() => {
    if (!lobbyShown) return;
    const p = new GuestPreview({ micId: prefs.micId, cameraId: prefs.cameraId, speakerId: prefs.speakerId });
    setPreview(p);
    void p.start({ mic: prefs.mic, camera: prefs.camera });
    return () => {
      p.dispose();
      setPreview((cur) => (cur === p ? null : cur));
    };
    // The preview is opened once per stay in the lobby; device choices made
    // in it live on the preview itself and are saved from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobbyShown]);

  // Remember the devices the guest picks, for the next link too.
  useWatchEffect(() => {
    if (!preview) return;
    return preview.subscribe(() => {
      const c = preview.getSnapshot().choice;
      setPrefs((p) => {
        if (p.micId === c.micId && p.cameraId === c.cameraId && p.speakerId === c.speakerId) return p;
        const next = { ...p, ...c };
        writeMediaPrefs(next);
        return next;
      });
    });
  }, [preview]);

  const toggleDevice = (kind: "mic" | "camera", on: boolean) => {
    setPrefs((p) => {
      const next = { ...p, [kind]: on };
      writeMediaPrefs(next);
      return next;
    });
  };

  const knock = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJoin({ token, name, accept_notice: true, ...(creds ?? {}) });
      writeName(name);
      if (res.secret) {
        const next = { guest_id: res.guest_id, secret: res.secret };
        writeCreds(token, next);
        setCreds(next);
      }
      setBackToLobby(false);
    } catch (err) {
      setError(humanizeConvexError(err, "Could not ask to join"));
    } finally {
      setBusy(false);
    }
  };

  const stopAsking = async () => {
    if (!creds) return;
    setBusy(true);
    setBackToLobby(true);
    await leaveCall(creds).catch(() => {});
    setBusy(false);
  };

  // Into the media room: a token for this admitted guest, the lobby's tracks
  // handed over so the camera does not blink, and the room's own reconnect
  // from there. One join at a time, whatever re-renders in between.
  const enter = async () => {
    if (!creds || joining.current) return;
    joining.current = true;
    setError(null);
    const tracks = preview?.handOff() ?? { video: null, audio: null };
    const choice = preview?.getSnapshot().choice ?? prefs;
    const next = new GuestCall(choice);
    setCall(next);
    try {
      const minted = await mintToken(creds);
      await next.connect(minted, tracks);
    } catch (err) {
      tracks.video?.stop();
      tracks.audio?.stop();
      await next.leave();
      setCall(null);
      setError(humanizeConvexError(err, "Could not join the call"));
    } finally {
      joining.current = false;
    }
  };

  // Let in while this page was at the door (and touched: they pressed Ask):
  // walk in without another press.
  useWatchEffect(() => {
    if (view === "admitted" && !call && preview && pageWasTouched()) void enter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, call, preview]);

  // Out, however it happened: the server's word ends the media too.
  useWatchEffect(() => {
    if (call && view && view !== "admitted") {
      void call.leave();
      setCall(null);
    }
  }, [view, call]);

  const leave = async () => {
    if (!creds) return;
    const c = call;
    setCall(null);
    await c?.leave();
    await leaveCall(creds).catch(() => {});
  };

  const reconnect = async () => {
    const c = call;
    setCall(null);
    await c?.leave();
    // The lobby opens a fresh preview; the admitted effect walks back in.
  };

  // ── What to draw ──────────────────────────────────────────────────────────

  if (describe.error || guest.error) {
    return (
      <MeetShell>
        <GuestOutcome outcome={{ kind: "unreachable" }} onAskAgain={() => location.reload()} busy={false} error={null} />
      </MeetShell>
    );
  }
  if (link === undefined || (creds && state === undefined)) {
    return <AppLoader className="h-dvh min-h-0 bg-[#002b36]" />;
  }

  const room = state?.room ?? null;
  const info = room ?? (link.ok ? link : null);
  const title = meetingTitle(info?.title ?? null, info?.inviter ?? null);
  const transcribed = !!info?.transcribed;
  const recording = !!info?.recording;

  if (call && view === "admitted") {
    return (
      <GuestInCall
        call={call}
        title={title}
        myName={state?.name ?? name}
        transcribed={transcribed}
        recording={recording}
        onLeave={() => void leave()}
        onReconnect={() => void reconnect()}
      />
    );
  }

  // Where the guest stands, when it is anywhere but the lobby.
  let outcome: Outcome | null = null;
  if (!link.ok && !atDoorOrIn) outcome = { kind: "refused", reason: link.reason };
  else if (state && view && !atDoorOrIn && !backToLobby) {
    outcome = {
      kind: "view",
      view: view as Exclude<CallGuestView, "waiting" | "admitted">,
      leftReason: state.left_reason,
      retryAt: state.retry_at,
      canAskAgain: state.link_open && link.ok,
      reason: !link.ok ? link.reason : undefined,
    };
  }
  if (outcome) {
    return (
      <MeetShell>
        <GuestOutcome outcome={outcome} onAskAgain={() => void knock()} busy={busy} error={error} />
      </MeetShell>
    );
  }

  if (!preview) return <AppLoader className="h-dvh min-h-0 bg-[#002b36]" />;
  const mode: LobbyMode = view === "waiting" ? "waiting" : view === "admitted" ? "rejoin" : "ask";
  return (
    <MeetShell>
      <GuestLobby
        preview={preview}
        mode={mode}
        title={title}
        inviter={info?.inviter ?? null}
        live={!!info?.live}
        transcribed={transcribed}
        recording={recording}
        name={name}
        onName={setName}
        onAsk={() => void knock()}
        onCancel={() => void stopAsking()}
        onJoin={() => void enter()}
        onToggle={toggleDevice}
        busy={busy || (mode === "rejoin" && joining.current)}
        error={error}
        waitingSince={waitingSince}
      />
    </MeetShell>
  );
}
