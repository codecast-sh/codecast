// In-place machine switch: the transcript divider a session keeps when it
// changes which box it runs on without forking. One notice format, one parser —
// Convex inserts it the moment the picker fires, the web/mobile timeline renders
// it, and the later daemon reorientation notice ("This session just moved")
// classifies as the same kind so the two fold into one divider.
//
// PURE isomorphic data — no Node or DOM APIs.

/** First line of the picker-time switch notice. Parallel to AGENT_SWITCH_NOTICE_PREFIX. */
export const MACHINE_SWITCH_NOTICE_PREFIX = "[codecast] Now running on";

/** First line of the destination daemon's reorientation notice (sessionMoveNotice.ts). */
export const MACHINE_MOVE_NOTICE_PREFIX = "[codecast] This session just moved";

const SHORT_LINE_RE =
  /^\[codecast\] Now running on (.+?)(?: \(was (.+?)\))?\.\s*$/;
const LONG_MACHINE_RE =
  /moved to a different machine\. It now runs on (.+?) in \S/;

export type MachineSwitchNotice = {
  /** Caption after "Now running on", e.g. "Cloud Linux". */
  toLabel: string;
  /** Caption after "was", when the previous machine is known. */
  fromLabel?: string;
  /** False only for a same-machine directory move. */
  machineChanged: boolean;
};

/** Build the user-message body Convex inserts and the UI classifies. */
export function formatMachineSwitchNotice(opts: {
  toLabel: string;
  fromLabel?: string | null;
}): string {
  const toLabel = opts.toLabel.trim();
  const fromLabel = opts.fromLabel?.trim();
  const head = fromLabel && fromLabel !== toLabel
    ? `${MACHINE_SWITCH_NOTICE_PREFIX} ${toLabel} (was ${fromLabel}).`
    : `${MACHINE_SWITCH_NOTICE_PREFIX} ${toLabel}.`;
  return `${head}\n\nThis session continues here. History above is the same thread.`;
}

export function isMachineSwitchNotice(content: string | null | undefined): boolean {
  if (!content) return false;
  const t = content.trimStart();
  return t.startsWith(MACHINE_SWITCH_NOTICE_PREFIX) || t.startsWith(MACHINE_MOVE_NOTICE_PREFIX);
}

export function parseMachineSwitchNotice(
  content: string | null | undefined,
): MachineSwitchNotice | null {
  if (!isMachineSwitchNotice(content)) return null;
  const first = (content ?? "").trim().split("\n", 1)[0] ?? "";
  const short = first.match(SHORT_LINE_RE);
  if (short) {
    return {
      toLabel: short[1].trim(),
      ...(short[2]?.trim() ? { fromLabel: short[2].trim() } : {}),
      machineChanged: true,
    };
  }
  const machine = first.match(LONG_MACHINE_RE);
  if (machine) return { toLabel: machine[1].trim(), machineChanged: true };
  if (/different directory/.test(first)) {
    return { toLabel: "another directory", machineChanged: false };
  }
  const rest = first.startsWith(MACHINE_SWITCH_NOTICE_PREFIX)
    ? first.slice(MACHINE_SWITCH_NOTICE_PREFIX.length).trim().replace(/\.$/, "")
    : "";
  return { toLabel: rest || "another machine", machineChanged: true };
}
