// Run a reader or an action from the Apps board, as the person looking at it:
// a field per declared argument, the call through the same path an agent's
// takes (sources/app read and doAction, so it is checked, signed, granted and
// logged under Recent calls the same way), and the app's answer under it. An
// action runs only while it is granted; a high-risk one goes through the
// shared confirm flow first, and one that is not idempotent gets a fresh
// idempotency key per press.
import { useState } from "react";
import { Play } from "lucide-react";
import type { JsonSchema } from "@codecast/shared/contracts/appConnector";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { schemaParams } from "./appsModel";
import type { AppRunner, ManifestCheck, RunOutcome } from "./appRunner";
import { argsFromForm, formatAnswer, isJson, isNum } from "./sourceViewModel";

type Values = Record<string, string | boolean>;
type Outcome = RunOutcome;

export function EntryRun({ source, kind, entry, granted = true, runner }: {
  source: { name: string };
  runner: AppRunner;
  kind: "read" | "do";
  entry: { name: string; title: string; input?: JsonSchema; risk?: string; idempotent?: boolean; method?: string; path?: string };
  /** An action runs only while granted. */
  granted?: boolean;
}) {
  const params = schemaParams(entry.input);
  const [values, setValues] = useState<Values>({});
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  const { args, errors } = argsFromForm(params, values);
  const blocked = kind === "do" && !granted ? "Grant it to run" : errors[0] ?? null;

  const run = async () => {
    setRunning(true);
    setOut(null);
    try {
      const key = kind === "do" && !entry.idempotent ? `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` : undefined;
      setOut(await runner.call(kind, entry.name, JSON.stringify(args), { idempotencyKey: key }));
    } catch (e) {
      setOut({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  const label = kind === "read" ? "Read now" : "Run";
  const button = (press: () => void) => (
    <button type="button" className="ops-btn" data-tone={kind === "do" ? "primary" : undefined} disabled={!!blocked || running} title={blocked ?? undefined} onClick={press} data-ops-run={entry.name}>
      <Play className="w-3.5 h-3.5" />{running ? "Running" : label}
    </button>
  );

  return (
    <div className="ops-run" data-ops-run-form={entry.name}>
      {params.length > 0 && (
        <div className="ops-run-fields">
          {params.map((p) => (
            <label key={p.name} className="ops-run-field">
              <span className="ops-mono">{p.name}{p.required ? <b aria-label="required"> *</b> : null}</span>
              {p.type === "boolean" ? (
                <input type="checkbox" checked={!!values[p.name]} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.checked }))} />
              ) : p.type.includes(" | ") ? (
                <select value={String(values[p.name] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}>
                  <option value="">{p.required ? "Pick one" : "None"}</option>
                  {p.type.split(" | ").map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : isJson(p.type) ? (
                <textarea rows={3} className="ops-mono" placeholder={p.type === "array" ? "[]" : "{}"} value={String(values[p.name] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} />
              ) : (
                <input type={isNum(p.type) ? "number" : "text"} placeholder={p.description ?? p.type} value={String(values[p.name] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} />
              )}
            </label>
          ))}
        </div>
      )}
      <div className="ops-run-acts">
        {kind === "do" && entry.risk === "high" ? (
          <ConsequentialSwitch
            on={false}
            ledger={{
              name: entry.title,
              subject: source.name,
              shift: null,
              alert: "High risk",
              figures: [{ value: entry.idempotent ? "Safe" : "Runs again", label: entry.idempotent ? "to run twice" : "each press", ...(entry.idempotent ? {} : { tone: "warn" as const }) }],
              rows: [
                { k: "Action", v: entry.name },
                ...(entry.path ? [{ k: "Route", v: `${entry.method ?? "POST"} ${entry.path}` }] : []),
                { k: "Arguments", v: Object.keys(args).length ? JSON.stringify(args) : "none" },
                { k: "Runs as", v: "You, signed and logged under Recent calls" },
              ],
              confirm: "Run",
              ...(blocked ? { blocked } : {}),
            }}
            onTurnOn={() => void run()}
            onTurnOff={() => {}}
            trigger={({ press }) => button(press)}
          />
        ) : (
          button(() => void run())
        )}
        {out && (
          <span className="ops-run-status" data-tone={out.ok ? "ok" : "bad"}>
            {out.ok ? "OK" : out.denied ? "Denied" : "Failed"}
            {out.status ? <span className="ops-num"> {out.status}</span> : null}
            {out.ms != null ? <span className="ops-dim ops-num"> {out.ms} ms</span> : null}
          </span>
        )}
      </div>
      {out && (out.text || out.error) && <pre className="ops-fulltext ops-run-out">{out.ok ? formatAnswer(out.text) : out.error}</pre>}
    </div>
  );
}

/**
 * An app source whose manifest codecast has not read: what the app must
 * serve, the last reason the read failed, and a press to read it again now.
 */
export function NoManifest({ source, runner }: { source: { name: string; short_id?: string; last_error?: string }; runner?: AppRunner }) {
  const [state, setState] = useState<{ busy: boolean; result: ManifestCheck | null }>({ busy: false, result: null });
  const why = state.result && !state.result.ok ? state.result.error : source.last_error?.startsWith("manifest:") ? source.last_error : null;
  const check = async () => {
    setState({ busy: true, result: null });
    try {
      setState({ busy: false, result: runner ? await runner.refresh() : null });
    } catch (e) {
      setState({ busy: false, result: { ok: false, error: e instanceof Error ? e.message : String(e) } });
    }
  };
  return (
    <section className="ops-card ops-nomanifest" aria-label="Manifest" data-ops-no-manifest>
      <div className="ops-card-head"><span>No manifest read yet</span></div>
      <dl className="ops-kv">
        <dt>Serve</dt><dd className="ops-mono">GET /codecast/manifest</dd>
        {source.short_id && <><dt>codecast.json</dt><dd className="ops-mono">names {source.short_id}</dd></>}
        {why && <><dt>Last read</dt><dd><pre className="ops-fulltext">{why}</pre></dd></>}
        {state.result?.ok && <><dt>Read</dt><dd className="ops-num">{state.result.readers ?? 0} readers · {state.result.actions ?? 0} actions · {state.result.watches ?? 0} watches</dd></>}
      </dl>
      <div className="ops-run-acts">
        <button type="button" className="ops-btn" data-tone="primary" disabled={state.busy || !runner} onClick={() => void check()} data-ops-manifest-check>{state.busy ? "Reading" : "Check again"}</button>
      </div>
    </section>
  );
}
