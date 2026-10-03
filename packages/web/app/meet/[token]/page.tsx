"use client";

import { useRef, useState, useSyncExternalStore } from "react";
// react-router itself, never the next/navigation shim: the shim carries the
// app store, which this page must not load (standaloneBootGraph guard).
import { useParams } from "react-router";
import { useAction, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  CALL_HEARTBEAT_MS,
  humanizeConvexError,
  type CallGuestView,
  type GuestLinkRefusal,
  type GuestNotice,
} from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { AppLoader } from "../../../components/AppLoader";
import { steadyInterval } from "../../../lib/steadyInterval";
import { hasStoredAuthToken } from "../../../lib/localAuth";
import { GuestCall, GuestPreview } from "../../../lib/calls/guestRoom";
import { GuestLobby, type LobbyMode } from "./GuestLobby";
import { GuestInCall } from "./GuestInCall";
import { GuestOutcome, type Outcome } from "./GuestOutcome";
import { MeetShell } from "./MeetChrome";
import { meetingTitle } from "../../../lib/calls/roomGuests";
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
 * The page beats (guestHeartbeat) while it is at the door or in the media,
 * which is the guest's lease: a closed tab drops off the door, and an
 * admitted guest whose page went quiet is let go by the server. The beat
 * keeps time from a worker (steadyInterval), because a background tab's own
 * timers slow to a minute and a late beat would read as a second knock. An
 * admitted guest who is NOT in the media (the one-press rejoin after a
 * reload, a dropped connection) beats only for REJOIN_HOLD_MS, so the room
 * never lists somebody who cannot hear it. Closing the tab hangs up the
 * media at once (LiveKit disconnects on page leave); it does not mark them
 * left, so a reload is a blink and not a second knock.
 *
 * Consent is the notice the guest asked under (`accepted`). They walk in on
 * their own only while the room keeps no more than they agreed to: a
 * recording that started while they waited holds them at the lobby, which
 * says so, until they press Join.
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
  knocked_at: number | null;
  creator_told: boolean;
  link_open: boolean;
  room: null | {
    title: string | null;
    inviter: { name: string | null; image?: string | null };
    live: boolean;
    transcribed: boolean;
    recording: boolean;
  };
};

const noSubscribe = () => () => {};
const noSnapshot = () => null;

/** How long an admitted guest who is out of the media keeps their place in
 *  the room's lists: long enough for a reload or a flaky network, short
 *  enough that the room does not show a face that hears nothing. The server
 *  lets the admission lapse a little after (GUEST_ADMISSION_LAPSE_MS). */
const REJOIN_HOLD_MS = 60_000;

/** Has the guest touched this page (a click, a key)? Without it the browser
 *  holds the call's sound. Older browsers without the API answer yes and let
 *  the in-call "turn on sound" line catch the rare block. */
function pageWasTouched(): boolean {
  const ua = (navigator as any).userActivation;
  return ua ? !!ua.hasBeenActive : true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const stopRecording = useMutation(api.callRecordings.guestStopRecording);
  const mintToken = useAction(api.callGuests.mintGuestToken);

  const [name, setName] = useState(readName);
  const [prefs, setPrefs] = useState(readMediaPrefs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stopped asking, or chose to ask again from an ending: the lobby, with
  // its preview and its notice, rather than a knock nobody saw them make.
  const [backToLobby, setBackToLobby] = useState(false);
  // The knock's own answer, for the moment between a first knock and the
  // first word from getGuestState (which only subscribes once the secret
  // exists): the lobby stays up and the camera stays on through it.
  const [knockedView, setKnockedView] = useState<CallGuestView | null>(null);
  // The notice the guest asked to join under (or last pressed Join under),
  // this visit. null after a reload: then nothing walks them in on its own.
  const [accepted, setAccepted] = useState<GuestNotice | null>(null);
  const [call, setCall] = useState<GuestCall | null>(null);
  const [entering, setEntering] = useState(false);
  // Walked out on purpose. The admission stays true for a beat after Leave,
  // until the server's word arrives; in that beat the page already shows the
  // guest out (their own act paints at once) and never walks back in or
  // opens the camera again on its own. The ref is the same fact for code
  // that runs after an await.
  const [leftByMe, setLeftByMe] = useState(false);
  const leftRef = useRef(false);
  // One automatic entry per admission: a join that fails is the guest's to
  // retry, not a loop's.
  const autoEntered = useRef(false);
  // Walked in on their own while the tab was in the background: the tab's
  // title says so until they look.
  const [enteredUnseen, setEnteredUnseen] = useState(false);
  // A fresh preview after a failed join (its tracks went to the call).
  const [previewEpoch, setPreviewEpoch] = useState(0);
  // The last beat found every waiting place at the door taken: this page is
  // not at the door until one frees, and each beat asks again (doorHasRoom).
  const [doorFull, setDoorFull] = useState(false);
  // The two things the page needs from the media, read as strings so the
  // page does not re-render for every speaking ring (GuestInCall reads the rest).
  const phase = useSyncExternalStore(call ? call.subscribe : noSubscribe, () => call?.getSnapshot().phase ?? null, noSnapshot);
  const ended = useSyncExternalStore(call ? call.subscribe : noSubscribe, () => call?.getSnapshot().ended ?? null, noSnapshot);

  // A secret the server no longer knows (a cleared database, a hand-edited
  // store): forget it and start at the lobby.
  useWatchEffect(() => {
    if (creds && state === null) {
      clearCreds(token);
      setCreds(null);
    }
  }, [creds, state, token]);

  const view: CallGuestView | null = state?.view ?? (creds && state === undefined && !guest.error ? knockedView : null);
  const atDoorOrIn = view === "waiting" || view === "admitted";
  const inMedia = !!phase && phase !== "disconnected";

  // What the room keeps, from whichever answer is current.
  const room = state?.room ?? null;
  const info = room ?? (link?.ok ? link : null);
  const title = meetingTitle(info?.title ?? null, info?.inviter ?? null);
  const transcribed = !!info?.transcribed;
  const recording = !!info?.recording;
  const notice: GuestNotice = { recording, transcribed };
  // The room keeps more than the guest agreed to when they asked.
  const widened = !!accepted && ((recording && !accepted.recording) || (transcribed && !accepted.transcribed));

  // The lease. See the header: worker-timed, at once when the tab comes back
  // to the front, and for an admitted guest out of the media only while
  // REJOIN_HOLD_MS lasts. The beat reads the media state through a ref so a
  // reconnect does not restart the clock.
  // The hold counts from whichever came last: leaving the media, or being let
  // in. A guest who waited at the door for minutes was "out of the media" the
  // whole time, and timing the hold from page load stopped their beat the
  // instant they were admitted, so a guest still answering the permission
  // prompt, or one press away from walking in, lapsed out of a call they had
  // just been let into.
  const admitted = view === "admitted";
  const media = useRef({ inMedia, outSince: Date.now() });
  useWatchEffect(() => {
    media.current = { inMedia, outSince: inMedia ? 0 : Date.now() };
  }, [inMedia, admitted]);
  const beatingAs = creds && atDoorOrIn && !leftByMe ? view : null;
  useWatchEffect(() => {
    if (!creds || !beatingAs) return;
    const beat = () => {
      const m = media.current;
      if (beatingAs === "admitted" && !m.inMedia && Date.now() - m.outSince > REJOIN_HOLD_MS) return;
      void heartbeat(creds)
        .then((r) => setDoorFull(beatingAs === "waiting" && !!r && "door_full" in r && !!r.door_full))
        .catch(() => {});
    };
    beat();
    const stop = steadyInterval(beat, CALL_HEARTBEAT_MS);
    const onVisible = () => document.visibilityState === "visible" && beat();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [creds?.guest_id, creds?.secret, beatingAs]);

  useWatchEffect(() => {
    if (view === "waiting" || view === "admitted") setBackToLobby(false);
    if (view !== "waiting") setDoorFull(false);
    if (view !== "admitted") {
      setLeftByMe(false);
      leftRef.current = false;
      autoEntered.current = false;
    }
  }, [view]);

  // The preview lives while the guest is choosing, knocking, or about to
  // walk in, and its camera turns off the moment they are anywhere else.
  // An admission does not hang on the link (callGuests.ts), so an admitted
  // guest's lobby opens whatever became of the link since.
  const lobbyShown = !call && !leftByMe && (atDoorOrIn || ((!creds || backToLobby) && (link?.ok ?? false)));
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
  }, [lobbyShown, previewEpoch]);

  // Whether the preview is still asking the browser for its devices: a guest
  // let in while the prompt is up walks in once it is answered, with them.
  const previewAsking = useSyncExternalStore(
    preview ? preview.subscribe : noSubscribe,
    () => preview?.getSnapshot().asking ?? false,
    () => false,
  );

  // One record of the guest's devices: what they pick and switch on or off,
  // in the lobby or inside the call, is what the next preview opens (a
  // reconnect, a reload, the next link). Never back on by itself.
  const remember = (next: Partial<typeof prefs>) =>
    setPrefs((p) => {
      const merged = { ...p, ...next };
      if ((Object.keys(merged) as Array<keyof typeof p>).every((k) => merged[k] === p[k])) return p;
      writeMediaPrefs(merged);
      return merged;
    });
  useWatchEffect(() => {
    if (!preview) return;
    return preview.subscribe(() => remember(preview.getSnapshot().choice));
  }, [preview]);
  useWatchEffect(() => {
    if (!call) return;
    return call.subscribe(() => {
      const c = call.getSnapshot();
      remember({ ...c.choice, ...c.wants });
    });
  }, [call]);

  const toggleDevice = (kind: "mic" | "camera", on: boolean) => remember({ [kind]: on });

  const knock = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJoin({ token, name, accept_notice: true, ...(creds ?? {}) });
      writeName(name);
      setAccepted(notice);
      setKnockedView(res.status);
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
    setKnockedView(null);
    await leaveCall(creds).catch(() => {});
    setBusy(false);
  };

  // Into the media room: a token for this admitted guest, the lobby's tracks
  // handed over so the camera does not blink, and the room's own reconnect
  // from there. One join at a time, whatever re-renders in between. A press
  // is consent to the notice on the screen it was made from.
  const enter = async (pressed: boolean) => {
    if (!creds || entering || !preview) return;
    if (pressed) setAccepted(notice);
    setEntering(true);
    setError(null);
    const tracks = preview.handOff();
    const choice = preview.getSnapshot().choice;
    const next = new GuestCall(choice, { mic: prefs.mic, camera: prefs.camera });
    setCall(next);
    try {
      const minted = await mintToken(creds);
      await next.connect(minted, tracks);
    } catch (err) {
      tracks.video?.stop();
      tracks.audio?.stop();
      await next.leave();
      setCall((cur) => (cur === next ? null : cur));
      // Left while it was still connecting: that is the leaving, not an error.
      if (leftRef.current) return;
      setPreviewEpoch((n) => n + 1);
      setError(humanizeConvexError(err, "Could not join the call"));
    } finally {
      setEntering(false);
    }
  };

  // Let in while this page was at the door: walk in without another press,
  // under the notice they asked under. A room that started keeping more
  // since (a recording, a transcript switched on) holds them at the lobby,
  // which says what changed; a recording is not something to be walked into.
  useWatchEffect(() => {
    if (view !== "admitted" || call || !preview || previewAsking) return;
    if (leftByMe || autoEntered.current || !accepted || widened || !pageWasTouched()) return;
    autoEntered.current = true;
    if (document.hidden) setEnteredUnseen(true);
    void enter(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, call, preview, previewAsking, leftByMe, accepted, widened]);
  useWatchEffect(() => {
    if (!enteredUnseen) return;
    const onVisible = () => document.visibilityState === "visible" && setEnteredUnseen(false);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enteredUnseen]);

  // Out, however it happened: the server's word ends the media too.
  useWatchEffect(() => {
    if (call && view && view !== "admitted") {
      void call.leave();
      setCall(null);
    }
  }, [view, call]);

  const leave = async () => {
    if (!creds) return;
    leftRef.current = true;
    setLeftByMe(true);
    const c = call;
    setCall(null);
    await c?.leave();
    // The beat stopped with the press, so a server that never hears this
    // lets the lease lapse anyway; a few tries make it say "left" instead.
    for (let i = 0; i < 4; i++) {
      try {
        await leaveCall(creds);
        return;
      } catch {
        await sleep(1000 * 2 ** i);
      }
    }
  };

  const reconnect = async () => {
    const c = call;
    // The lobby opens a fresh preview with the devices as the guest last
    // left them, and the admitted effect walks back in with a new token: a
    // dropped connection is a new connection.
    autoEntered.current = false;
    setCall(null);
    await c?.leave();
  };

  // A connection lost to the network comes back with the network, once.
  useWatchEffect(() => {
    if (ended !== "lost") return;
    const onOnline = () => void reconnect();
    window.addEventListener("online", onOnline, { once: true });
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended]);

  // The tab says where the guest is: a tab among twenty others is how most of
  // them will come back to it.
  const tabInfo = state?.room ?? (link?.ok ? link : null);
  const tabTitle = tabInfo
    ? `${enteredUnseen ? "You're in · " : call && view === "admitted" ? "" : "Join "}${meetingTitle(tabInfo.title, tabInfo.inviter)} · codecast`
    : "codecast";
  useWatchEffect(() => {
    document.title = tabTitle;
  }, [tabTitle]);

  // ── What to draw ──────────────────────────────────────────────────────────

  const serverError = describe.error || guest.error;

  // Inside, nothing a query says takes the call away: the media is fine and
  // so are the guest's own controls. A server we lost touch with is a line.
  if (call && (view === "admitted" || (serverError && !leftByMe))) {
    return (
      <GuestInCall
        call={call}
        title={title}
        myName={state?.name ?? name}
        transcribed={transcribed}
        recording={recording}
        recordingAccepted={accepted?.recording ?? false}
        serverTrouble={!!serverError}
        onLeave={() => void leave()}
        onReconnect={() => void reconnect()}
        onStopRecording={() => (creds ? stopRecording({ guest_id: creds.guest_id, secret: creds.secret }) : Promise.reject(new Error("You are not in the call")))}
      />
    );
  }

  if (serverError) {
    return (
      <MeetShell>
        <GuestOutcome outcome={{ kind: "unreachable" }} onAskAgain={() => location.reload()} busy={false} error={null} />
      </MeetShell>
    );
  }
  if (link === undefined || (creds && state === undefined && !knockedView)) {
    return <AppLoader className="h-dvh min-h-0 bg-[#002b36]" />;
  }

  // Where the guest stands, when it is anywhere but the lobby. Asking again
  // from any ending goes back to the lobby: the notice is read and the
  // camera checked again, not skipped by a button on the way out.
  const askAgain = () => {
    setError(null);
    setBackToLobby(true);
  };
  let outcome: Outcome | null = null;
  if (leftByMe && view === "admitted") {
    outcome = { kind: "view", view: "left", leftReason: "self", retryAt: null, canAskAgain: link.ok };
  } else if (!link.ok && !atDoorOrIn) outcome = { kind: "refused", reason: link.reason };
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
        <GuestOutcome outcome={outcome} onAskAgain={askAgain} busy={busy} error={error} />
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
        accepted={accepted}
        creatorTold={!!state?.creator_told}
        doorFull={doorFull}
        signedIn={mode === "ask" && hasStoredAuthToken()}
        name={name}
        onName={setName}
        onAsk={() => void knock()}
        onCancel={() => void stopAsking()}
        onJoin={() => void enter(true)}
        onToggle={toggleDevice}
        busy={busy || entering}
        error={error}
        waitingSince={state?.knocked_at ?? null}
      />
    </MeetShell>
  );
}
