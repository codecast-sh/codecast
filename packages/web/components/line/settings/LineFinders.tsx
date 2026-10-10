"use client";
// "Listens to": the finders the profile declares, each with what it files,
// the signal it last filed and how long it has been silent. The health comes
// from the same Sense derivation the line page reads (lib/lineFlow
// buildLineFlow), so both pages say the same thing about a finder.
import { useState } from "react";
import { splitFinderKind, type LineFinderInput, type LineProfileEdit, type PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { isBuiltInSource, type SenseSource } from "../../../lib/lineFlow";
import { groupingWords, sourceCounts, sourceHealth, sourceSentence } from "../../../lib/line/lineSources";
import { finderInput, suggestFinder } from "../../../lib/lineSettings";
import { ConfirmButton } from "../../integrations/parts";
import { EditStatus, InlineEdit, SourceTag } from "./LineValueRow";
import type { EditState } from "./useLineProfileEdits";

type Finder = PublishedLineProfile["finders"][number];

const kindText = (k: Finder["kind"]) => (k === "any" ? "any" : k.join(", "));

/** The parts of a source's settings, what each is, and an example. The add
 *  form asks for the first four (the loader needs them); an existing source
 *  edits the rest in place, its id being its name in the file. */
const FINDER_FIELDS: Array<{ key: "id" | "source" | "kind" | "fingerprint" | "runs"; name?: string; what: string; placeholder: string; required: boolean }> = [
  { key: "id", what: "its name in the settings file", placeholder: "sentry-web", required: true },
  { key: "source", what: "the tool its reports come from", placeholder: "sentry", required: true },
  { key: "kind", what: "what it reports: bug, regression and so on, or any", placeholder: "bug, regression", required: true },
  { key: "fingerprint", name: "groups by", what: "the key that groups its reports into one problem", placeholder: "sentry:<issue>", required: true },
  { key: "runs", what: "the scheduled job that runs it, if one does", placeholder: "the trigger's id", required: false },
];
const EDITED_IN_PLACE = FINDER_FIELDS.filter((f) => f.key !== "id");
const ASKED_ON_ADD = FINDER_FIELDS.filter((f) => f.required);

export function LineFinders({ lp, sense, now, writable, readOnlyWhy, states, device, send, clear }: {
  lp: PublishedLineProfile;
  sense: SenseSource[];
  now: number;
  writable: boolean;
  /** Why the finders cannot be edited here, when the rest can. */
  readOnlyWhy?: string | null;
  states: Record<string, EditState>;
  device: string;
  send: (edits: LineProfileEdit[], as?: string) => void;
  clear: (key: string) => void;
}) {
  const bySource = new Map(sense.map((s) => [s.source.toLowerCase(), s]));
  // Filing here without a declaration, declared finders or none (a person and lessons need none).
  const undeclared = sense.filter((s) => !s.finder && s.week > 0 && !isBuiltInSource(s.source));
  const canEdit = writable && !readOnlyWhy;
  const [adding, setAdding] = useState(false);

  const update = (f: Finder, patch: Partial<LineFinderInput>) => send([{ op: "set_finder", finder: { ...finderInput(f), ...patch } }]);

  return (
    <div className="lset-finders" data-lset-finders>
      {/* An undeclared finder's own box below says it once, with the action; no sentence repeats it. */}
      {lp.finders.length === 0 && undeclared.length === 0 && <p className="lset-empty" data-lset-finders-empty>No source reports into this line yet. Add one below, such as Sentry, PostHog or an eval, and it reports what it sees on its own.</p>}
      {lp.finders.map((f) => {
        const health = bySource.get(f.source.toLowerCase());
        const key = `finders.${f.id}`;
        const state = sourceHealth(health ?? { newest: null, silent: false, day: 0 }, now);
        return (
          <div key={f.id} className="lset-finder" data-silent={health?.silent ? "true" : undefined} data-lset-finder={f.id}>
            <div className="lset-finder-head">
              <span className="lset-finder-source">{f.source}</span>
              <span className="lset-source-state" data-tone={state.tone} data-lset-finder-health>{state.words}</span>
              {canEdit && <ConfirmButton label="remove" confirmLabel="Remove this source" className="lset-remove" onConfirm={() => send([{ op: "remove_finder", id: f.id }])} />}
            </div>
            <p className="lset-source-says">{sourceSentence(f.source, f)}</p>
            <p className="lset-source-count">{sourceCounts(health ?? { week: 0, newest: null }, now)}{health?.newest ? ":" : "."}</p>
            {health?.newest && <p className="lset-finder-latest" title={health.newest.title}>{health.newest.title}</p>}
            <details className="lset-source-more">
              <summary>Its settings</summary>
              <dl className="lset-finder-fields">
                {EDITED_IN_PLACE.map((ff) => {
                  const key = ff.key as Exclude<typeof ff.key, "id">;
                  const text = key === "kind" ? kindText(f.kind) : (f[key] ?? "");
                  return (
                    <div key={ff.key} className="lset-finder-field">
                      <dt title={ff.what}>{ff.name ?? ff.key}<span className="lset-what">{ff.what}</span></dt>
                      <dd>
                        <InlineEdit
                          text={text}
                          label={`${f.id} ${ff.name ?? ff.key}`}
                          placeholder={ff.placeholder}
                          disabled={!canEdit}
                          onCommit={(t) => {
                            const v = t.trim();
                            if (!v && ff.required) return `A source needs ${ff.name ? `to say what it ${ff.name}` : `a ${ff.key}`}`;
                            update(f, key === "kind" ? { kind: splitFinderKind(v) } : key === "runs" ? { runs: v || undefined } : { [key]: v });
                          }}
                        />
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </details>
            <EditStatus s={states[key]} device={device} now={now} onDismiss={() => clear(key)} />
          </div>
        );
      })}
      {undeclared.map((s) => {
        const f = suggestFinder(s);
        return (
          <div key={s.source} className="lset-declare" data-lset-undeclared={s.source}>
            <span className="lset-declare-words"><b>{s.source}</b> reported {s.week} in the last 7 days but is not in this line's settings, so nobody is told if it goes quiet.{canEdit ? ` Adding it ${groupingWords(f.fingerprint)}; you can change that after.` : ""}</span>
            {canEdit && <button type="button" className="lset-add" onClick={() => send([{ op: "set_finder", finder: f }])} data-lset-declare={s.source}>Add {s.source} to the settings</button>}
          </div>
        );
      })}
      {/* While a declare box is the whole story, the foot waits; with finders declared it sits in one row. */}
      {!(lp.finders.length === 0 && undeclared.length > 0 && !adding) && <div className="lset-finders-foot">
        <SourceTag source={lp.sources?.finders ?? null} />
        {readOnlyWhy && <span className="lset-dim">{readOnlyWhy}</span>}
        {canEdit && !adding && <button type="button" className="lset-add" onClick={() => setAdding(true)} data-lset-focus>add a source</button>}
      </div>}
      {canEdit && adding && <AddFinder taken={lp.finders.map((f) => f.id)} onCancel={() => setAdding(false)} onAdd={(finder) => { setAdding(false); send([{ op: "set_finder", finder }]); }} />}
    </div>
  );
}

/** A new finder: the four keys the loader needs. */
function AddFinder({ taken, onAdd, onCancel }: { taken: string[]; onAdd: (f: LineFinderInput) => void; onCancel: () => void }) {
  const [f, setF] = useState({ id: "", source: "", kind: "", fingerprint: "" });
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const v = { id: f.id.trim(), source: f.source.trim(), kind: f.kind.trim(), fingerprint: f.fingerprint.trim() };
    const missing = (Object.keys(v) as Array<keyof typeof v>).filter((k) => !v[k]);
    if (missing.length) return setError(`Needs ${missing.join(", ")}`);
    if (taken.includes(v.id)) return setError(`A source named ${v.id} exists`);
    onAdd({ ...v, kind: splitFinderKind(v.kind) });
  };
  return (
    <form className="lset-add-form" onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }} data-lset-add-finder>
      {ASKED_ON_ADD.map((ff, i) => {
        const k = ff.key as keyof typeof f;
        return (
          <label key={k} className="lset-add-field">
            <span>{ff.name ?? k}<span className="lset-what">{ff.what}</span></span>
            <input
              autoFocus={i === 0}
              className="lset-input"
              value={f[k]}
              placeholder={ff.placeholder}
              onChange={(e) => { setF({ ...f, [k]: e.target.value }); setError(null); }}
            />
          </label>
        );
      })}
      <div className="lset-add-actions">
        {error && <span className="lset-field-error" role="alert">{error}</span>}
        <button type="button" className="lset-ghost" onClick={onCancel}>cancel</button>
        <button type="submit" className="lset-primary">add the source</button>
      </div>
    </form>
  );
}
