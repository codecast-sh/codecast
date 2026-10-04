// A callRooms row's recording fields, as calls.getLiveRooms answers them: the
// pure half of hooks/useRoomRecording ("one home"), kept free of the web call
// engine so every platform's live-rooms feeder files the same row.

export type RoomRecordingLive = {
  status: "starting" | "recording" | "stopping";
  run_id: string;
  started_by: { id: string; name: string };
  requested_at: number;
  /** The file's time 0: when the room began to be filmed. Null while starting. */
  started_at: number | null;
  /** A saving run: when it was asked to stop, which is what a new press
   *  waits on (RECORDING_RESTART_COOLDOWN_MS), not LiveKit's upload. */
  stop_requested_at: number | null;
  /** This run's video will be on the call's public link. */
  video_shared: boolean;
};

/** The recording fields of a callRooms row, flat so each is a scalar the
 *  store compares and a signature can name. `recording_status` is undefined
 *  on a row a server too old to say filed (then the flag is all there is)
 *  and null when the server said nothing runs. */
export type RoomRecordingFields = {
  recording?: boolean;
  recording_status?: RoomRecordingLive["status"] | null;
  recording_run_id?: string | null;
  recording_by_id?: string | null;
  recording_by_name?: string | null;
  recording_requested_at?: number | null;
  recording_started_at?: number | null;
  recording_configured?: boolean | null;
  /** Why a configured server cannot record right now (the LiveKit plan spent
   *  its minutes), or null when it can. */
  recording_unavailable?: string | null;
  recording_stop_requested_at?: number | null;
  recording_video_shared?: boolean | null;
};

const NO_RUN = {
  recording_status: null,
  recording_run_id: null,
  recording_by_id: null,
  recording_by_name: null,
  recording_requested_at: null,
  recording_started_at: null,
  recording_stop_requested_at: null,
  recording_video_shared: null,
} as const;

/** One room of calls.getLiveRooms as its callRooms recording fields (the
 *  feeder's half of the one home). A server that predates `recording_run`
 *  leaves the detail unsaid rather than saying "nothing runs". */
export function roomRecordingFields(room: any): RoomRecordingFields {
  const fields: RoomRecordingFields = { recording: !!room?.recording };
  if (room && "recording_configured" in room) fields.recording_configured = !!room.recording_configured;
  if (room && "recording_unavailable" in room) fields.recording_unavailable = room.recording_unavailable ?? null;
  if (!room || !("recording_run" in room)) return fields;
  const run = room.recording_run;
  if (!run) return { ...fields, ...NO_RUN };
  return {
    ...fields,
    recording_status: run.status,
    recording_run_id: String(run.run_id),
    recording_by_id: String(run.started_by?.id ?? ""),
    recording_by_name: String(run.started_by?.name ?? ""),
    recording_requested_at: run.requested_at ?? null,
    recording_started_at: run.started_at ?? null,
    recording_stop_requested_at: run.stop_requested_at ?? null,
    recording_video_shared: !!run.video_shared,
  };
}

/** The run a row describes: null when nothing runs, undefined when the row
 *  (or the server behind it) does not say. */
export function roomRecordingLive(row: RoomRecordingFields | null | undefined): RoomRecordingLive | null | undefined {
  if (!row || row.recording_status === undefined) return undefined;
  if (!row.recording_status || !row.recording_run_id) return null;
  return {
    status: row.recording_status,
    run_id: row.recording_run_id,
    started_by: { id: row.recording_by_id ?? "", name: row.recording_by_name ?? "" },
    requested_at: row.recording_requested_at ?? 0,
    started_at: row.recording_started_at ?? null,
    stop_requested_at: row.recording_stop_requested_at ?? null,
    video_shared: !!row.recording_video_shared,
  };
}

/** Is the room being recorded right now (a run starting or filming), read
 *  off the store's callRooms row: the one rule every platform's mark and
 *  notice reads, web and mobile alike. */
export function roomRecordingOn(state: { callRooms?: Record<string, RoomRecordingFields | undefined> }, roomKey: string | null | undefined): boolean {
  return !!roomKey && !!state.callRooms?.[roomKey]?.recording;
}
