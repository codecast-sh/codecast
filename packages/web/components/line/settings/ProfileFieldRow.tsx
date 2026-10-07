"use client";
// One value of a project's line profile, read and edited in place: the row
// line settings lists by section, and a map panel lists for its node
// (line-map.md LX3, LX5). An edit travels the profile's edit path
// (useLineProfileEdits); clearing a value the file sets puts back the default.
import type { LineProfileEdit, PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { commandNote, editForField, fieldText, lineSource, lineValue, type LineField } from "../../../lib/lineSettings";
import { EditStatus, InlineEdit, LineValueRow } from "./LineValueRow";
import type { EditState } from "./useLineProfileEdits";

export function ProfileFieldRow({ field, lp, writable, states, device, now, send, clear }: {
  field: LineField;
  lp: PublishedLineProfile;
  writable: boolean;
  states: Record<string, EditState>;
  device: string;
  now: number;
  send: (edits: LineProfileEdit[]) => void;
  clear: (key: string) => void;
}) {
  const value = lineValue(lp, field.key);
  const source = lineSource(lp, field.key);
  const s = states[field.key];
  const reset = source === "file" && writable ? () => send([{ op: "remove", key: field.key }]) : undefined;
  const commit = (text: string) => {
    const r = editForField(field, text, lp);
    if ("error" in r) return r.error;
    if (r.edit) send([r.edit]);
    return null;
  };
  return (
    <LineValueRow
      label={field.label}
      what={field.what}
      unit={field.unit}
      source={source}
      refused={s?.state === "refused"}
      note={value == null && field.key.startsWith("commands.") ? commandNote(lp, field.key) : null}
      status={<EditStatus s={s} device={device} now={now} onDismiss={() => clear(field.key)} />}
      onReset={reset}
      defaultText={fieldText(field, lineValue(null, field.key))}
    >
      <InlineEdit
        text={fieldText(field, value)}
        label={field.label}
        placeholder={field.placeholder}
        multiline={field.kind === "list"}
        disabled={!writable}
        display={field.kind === "list" && Array.isArray(value) && value.length ? <span className="lset-list">{value.map((v) => <span key={v}>{v}</span>)}</span> : undefined}
        onCommit={commit}
        onReset={reset}
      />
    </LineValueRow>
  );
}
