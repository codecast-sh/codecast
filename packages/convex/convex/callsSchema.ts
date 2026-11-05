import { defineTable } from "convex/server";
import { v } from "convex/values";
import { callRecordingErrorKindValidator, callRecordingKindValidator, callRecordingStatusValidator, callRecordingStopReasonValidator } from "./lib/callValidators";
import { chatAttachmentValidator } from "./lib/chatAttachment";

/**
 * A call's media and side channels: its video files, frame shares, recording
 * loops, in-call chat, agent feeds and linked sessions. A call itself is a
 * transcripts row (schema.ts).
 */
export const callTables = {
  // A call's video: one row per file LiveKit Egress writes for it, on the
  // call's record (a call IS a transcripts row). The model, the time rule and
  // the vocabulary live in shared/contracts/callRecordings.ts; in short:
  //   kind composite  the room as people saw it, faces and share, with audio.
  //                   One per press of Record.
  //   kind screen     one shared screen at its own resolution, no audio, for
  //                   legible frames. One per share while a run is on.
  // Stopping and pressing Record again adds rows; nothing is ever appended
  // to a finished file. "Is this call recording right now" is derived, never
  // stored: a composite row of the room whose status is still active
  // (isRecordingActive), read through by_room_status. That one fact is what
  // tells everyone in the room, guests and late joiners included.
  // Files live only in the private recordings bucket (lib/r2.ts) and are read
  // through short lived URLs minted after the call's own access check.
  // LiveKit is the truth about a file's state: the reconciler polls ListEgress
  // and writes what it says here (lib/livekitServer.ts recordingFieldsFromEgress).
  call_recordings: defineTable({
    transcript_id: v.id("transcripts"),
    room_key: v.string(),
    // Routing only, copied from the call record. Access is the call's
    // (canReadCall), never this field.
    team_id: v.id("teams"),
    kind: callRecordingKindValidator,
    status: callRecordingStatusValidator,
    // LiveKit's id, set once StartEgress answers. Absent on a row inserted
    // ahead of that call, which is how a press shows at once.
    egress_id: v.optional(v.string()),
    // The object key. Written as the requested filepath, then replaced by the
    // name LiveKit reports (it adds the extension a track's codec needs).
    r2_key: v.string(),
    // The JPEG LiveKit rewrites every few seconds while this file records
    // (r2.callRecordingLiveFramePrefix): the picture of a call still going on,
    // since the MP4 reaches the bucket only when its egress ends.
    live_frame_key: v.optional(v.string()),
    // Screen files: the shared track and whose screen it is (a user id, a
    // `guest:` identity, never an agent face), named as the room saw them.
    track_sid: v.optional(v.string()),
    participant_identity: v.optional(v.string()),
    participant_name: v.optional(v.string()),
    // Screen files: the composite row of the press they belong to (a run,
    // lib/callRecordingRuns.ts). A composite is its own run and has none.
    // Stopping and deleting act on a whole run.
    run_id: v.optional(v.id("call_recordings")),
    // Who pressed Record (screen files inherit their run's presser), and when.
    started_by: v.id("users"),
    // Their name as the team sees it, kept when the run was made (as
    // call_members keeps user_name): the live room list and the call's files
    // name the presser without reading their users row, which the daemon's
    // heartbeat and every message they send rewrite. Absent on older rows.
    started_by_name: v.optional(v.string()),
    requested_at: v.number(),
    // Wall ms of the file's time 0, from LiveKit's file result: the anchor of
    // every offset (locateCallMoment). Absent until LiveKit has begun writing.
    started_at: v.optional(v.number()),
    ended_at: v.optional(v.number()),
    duration_ms: v.optional(v.number()),
    size_bytes: v.optional(v.number()),
    // Why the file stopped, and who stopped it: a LiveKit identity (a user
    // id or `guest:<id>`), since any participant may stop a recording.
    stop_reason: v.optional(callRecordingStopReasonValidator),
    stopped_by: v.optional(v.string()),
    // When the stop was asked for (lib/callRecordingRuns.stopRoomRecording).
    // Its own stamp because updated_at moves with every later write: the
    // restart cooldown and the stuck-save timeout both count from here.
    stop_requested_at: v.optional(v.number()),
    // Why it failed, in plain words (lib/callRecordingRuns plainEgressError;
    // LiveKit's own text goes to the logs), and the kind of failure those
    // words describe. Decisions (may a screen file be asked for again?) read
    // the kind, so editing the words never changes what the loop does.
    error: v.optional(v.string()),
    error_kind: v.optional(callRecordingErrorKindValidator),
    // How many times this file has been asked of LiveKit (absent: once). A
    // refusal that passes (no capacity this minute, a timeout) is asked again
    // up to START_RETRY_LIMIT times on the same row. `retry_after` is when a
    // room video refused for want of capacity is asked again by its loop;
    // until then it reads "starting", so the room hears no failure.
    start_attempts: v.optional(v.number()),
    retry_after: v.optional(v.number()),
    // Composite rows: the facts of the call record the room's notices show,
    // copied here at their writers so a notice never reads the record
    // (writeSegments moves it on every transcript line, and the live room
    // list carries the notice to every teammate's window). The call's short
    // id and start (where the video lands in the call, for the notice's
    // link) are stamped at the press; whether this run's video goes out with
    // the public link is restamped by lib/callRecordingRuns restampRunShare
    // whenever the link or its video choice changes.
    call_short_id: v.optional(v.string()),
    call_started_at: v.optional(v.number()),
    video_shared: v.optional(v.boolean()),
    // Written only when something a reader shows changes. The reconcile
    // loop's own liveness lives in call_recording_loops, so a recording that
    // simply keeps recording writes nothing every subscriber would re-read.
    updated_at: v.number(),
  })
    .index("by_transcript", ["transcript_id", "requested_at"])
    .index("by_room_status", ["room_key", "status"])
    .index("by_egress", ["egress_id"])
    // The reconciler's worklist: every row LiveKit is still working on.
    .index("by_status", ["status"])
    // The newest press anywhere: the sweep asks LiveKit for untracked
    // egresses only when a press was recent enough to have left one.
    .index("by_requested", ["requested_at"]),

  // A frame of a recording uploaded as a public image (`cast call snap
  // --share`). The image itself is an ordinary storage object anyone with its
  // link can open; this row ties it to the file it was taken from, so
  // deleting the recording (callRecordings.deleteRecordingRun) deletes every
  // frame shared from it too, screens and guests' faces included.
  call_frame_shares: defineTable({
    recording_id: v.id("call_recordings"),
    transcript_id: v.id("transcripts"),
    storage_id: v.id("_storage"),
    // The picture's content hash, so the same frame shared twice from one
    // file is one object and one link (callRecordings.cliShareFrame).
    sha256: v.optional(v.string()),
    user_id: v.id("users"),
    created_at: v.number(),
    // The moment the picture shows, in ms on the call's clock: what the call
    // page's list of shared pictures and the room's thread line name.
    at_ms: v.optional(v.number()),
  })
    .index("by_recording", ["recording_id"])
    // The call page lists every picture of the call on a public link.
    .index("by_transcript", ["transcript_id"]),

  // One row per recording run: its reconcile loop's bookkeeping, kept apart
  // from call_recordings because every room and call page subscribes to
  // those rows, and a loop that stamped them each pass would re-run all of
  // them for nothing. `gen` is the loop that is current: a loop carries the
  // gen it was started with and stops when it no longer matches, so the
  // sweep replacing a stalled loop never leaves two polling one run.
  call_recording_loops: defineTable({
    run_id: v.id("call_recordings"),
    gen: v.number(),
    // The current loop's last look at LiveKit (the sweep's staleness clock).
    looked_at: v.number(),
    // The last one off look a screen share asked for (calls.heartbeat).
    nudged_at: v.optional(v.number()),
  }).index("by_run", ["run_id"]),

  // Text chat alongside a huddle: one thread per room, visible on the call
  // stage and the call page. Keyed by room so the chat works before the
  // huddle has a record; `transcript_id` says which huddle a line belongs to.
  call_chat_messages: defineTable({
    room_key: v.string(),
    team_id: v.optional(v.id("teams")),
    // The human who owns the line. For an agent's line this is whoever fed
    // the agent into the huddle (the route's adder): the agent speaks in the
    // room on that person's authority, the same way its transcript chunks
    // arrive as them.
    user_id: v.id("users"),
    text: v.string(),
    // Images pasted, dropped or picked in the huddle chat. Same shape as
    // chat_messages.attachments so the room reuses the chat tile, and the
    // same storage ids ride to fed sessions as pending_messages.image_storage_ids.
    attachments: v.optional(v.array(chatAttachmentValidator)),
    // Set when an AGENT said this: the session that is fed the huddle live
    // and answered. Rendered with the agent's identity, never as user_id's
    // own words. `source_message_id` is the session message it mirrors, so
    // a retried mirror can never post the same reply twice.
    agent_conversation_id: v.optional(v.id("conversations")),
    source_message_id: v.optional(v.id("messages")),
    // Set when this row is something the room SAW rather than something
    // somebody said: "agent_joined" | "agent_left" | "transcribe_on" |
    // "transcribe_off" | "record_on" | "record_off" | "record_lost" |
    // "record_deleted" | "frame_shared" | "video_shared" | "video_unshared" |
    // "link_on" | "link_off" | "guest_admitted" | "guest_removed".
    // record_lost follows a record_off already said: the stopped run's
    // video failed to save, and its plain words ride in `text`. link_on and
    // link_off are the call's public link turned on or off (its words open
    // to anyone with it); video_shared and video_unshared are its video put
    // on that link or taken off, video_shared with the filmed stretch it
    // covers in event_span.
    // `user_id` is who did it (the person who added or removed the agent,
    // pressed the transcription or recording switch, or let a guest in or
    // put one out, the guest named by event_guest_name); an agent event
    // also carries `agent_conversation_id`. `text` is empty, except a
    // recording that failed, which carries the failure in plain words, and
    // a frame_shared line (`cast call snap --share` put a picture of the call
    // on a public link), which carries the moment's reference (`cl-42@12:34`).
    // Written only by callChat.postEvent; never relayed to the fed sessions.
    event: v.optional(v.string()),
    // Why a record_off happened (a CallRecordingStopReason: "pressed",
    // "huddle_ended", "limit", "failed", ...). A stop nobody pressed is still
    // owned by the run's presser, so this, not `user_id`, says who or what
    // ended it.
    event_reason: v.optional(v.string()),
    // A guest did it (pressed Stop): the name the room knew them by. The row
    // is owned by the run's presser, since a line needs a user, and is shown
    // as the guest's. On guest_admitted / guest_removed it is the guest the
    // doorkeeper (user_id) let in or put out.
    event_guest_name: v.optional(v.string()),
    // The recording run a record_on / record_off / record_deleted line is
    // about (callRecordingRuns.runIdOf), so the thread can tell which run a
    // delete removed and mark that run's start and stop as gone. Absent on
    // lines written before it existed.
    event_run_id: v.optional(v.string()),
    // record_deleted: the stretch of the call the deleted run had filmed, in
    // ms on the call's clock (transcript started_at), so the line can say
    // which recording went. Absent when the run never began filming.
    event_span: v.optional(v.object({ from_ms: v.number(), to_ms: v.number() })),
    // The huddle this line was said in: the room's live transcript when it
    // was written (callChat.insertRoomRow), or the one a line typed before
    // the record existed was claimed by when it started. Absent on a line
    // typed in the room while no huddle was running.
    transcript_id: v.optional(v.id("transcripts")),
  })
    .index("by_room", ["room_key"])
    .index("by_transcript", ["transcript_id"]),

  // One row per session a live transcript feeds: the cheap answer to "is this
  // session in a huddle right now?", asked on every turn settle so the agent's
  // reply can be mirrored into the room chat. Written only by
  // transcripts.syncAgentFeeds, from the transcript's own routes, and gone the
  // moment the transcript ends or the route is removed. `last_mirrored_message_id`
  // is the watermark: the newest assistant message already shown in the room,
  // stamped at feed time with whatever the session last said so nothing said
  // BEFORE the huddle is replayed into it.
  call_agent_feeds: defineTable({
    conversation_id: v.id("conversations"),
    transcript_id: v.id("transcripts"),
    room_key: v.string(),
    team_id: v.optional(v.id("teams")),
    added_by: v.id("users"),
    last_mirrored_message_id: v.optional(v.id("messages")),
    // The route's choice, copied: false seats no face or voice for this agent.
    face: v.optional(v.boolean()),
    // When someone last asked this agent for something (a line naming it, or
    // its voice handing it work). Only a reply to such a turn is said aloud;
    // the rest stays in the call's chat (callChat.mirrorAgentTurn).
    addressed_at: v.optional(v.number()),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_transcript", ["transcript_id"]),

  // Every session a call's words reached, kept for good: the way from a call
  // to its agents and from an agent back to its call. call_agent_feeds dies
  // with the feed; this row outlives it. One row per (call, session), written
  // by transcripts.linkCallSession: a live feed sets `live`, each one-shot
  // send of the transcript or a range of it appends to `excerpts`.
  call_session_links: defineTable({
    transcript_id: v.id("transcripts"),
    conversation_id: v.id("conversations"),
    added_by: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
    live: v.optional(v.boolean()),
    // Segment seq ranges sent, inclusive, newest last (capped).
    excerpts: v.optional(v.array(v.object({
      from_seq: v.number(),
      to_seq: v.number(),
      at: v.number(),
    }))),
  })
    .index("by_transcript", ["transcript_id"])
    .index("by_conversation", ["conversation_id"]),
};
