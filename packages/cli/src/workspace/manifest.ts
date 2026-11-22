/**
 * Manifest parser: reads .codecast/workspace.toml, validates schema, returns
 * a partial WorkspaceManifest. The resolver layer (separate module) merges
 * this with detection defaults to produce a full manifest.
 *
 * TOML convention is snake_case; TypeScript uses camelCase. Conversion happens
 * here at the parser boundary so the rest of the system stays in one style.
 */

import * as fs from "node:fs";
import { envNameProblem, secretNameProblem } from "@codecast/shared/contracts/secretRules";
import { dataFolderFromManifest } from "@codecast/shared/contracts/dataSync";
import type {
  BrowserSpec,
  HostSpec,
  ShipDeployStep,
  ShipSpec,
  SyncSpec,
  PortSpec,
  RunJob,
  RunSpec,
  ServiceSpec,
  SetupSpec,
  TeardownSpec,
  VaultBinding,
  VerifySpec,
  WorkspaceManifest,
} from "./types.js";
export type { BrowserSpec };

/** Default BrowserSpec used when manifest omits [browser]. */
export const DEFAULT_BROWSER: BrowserSpec = {
  enabled: false,
  headless: true,
  cdpPort: { base: 9222, range: 100 },
};

/** Error thrown for malformed manifest content (not for missing files). */
export class ManifestError extends Error {
  constructor(
    message: string,
    public readonly file?: string,
    public readonly path?: string,
  ) {
    const loc = file ? ` (${file}${path ? `: ${path}` : ""})` : "";
    super(`${message}${loc}`);
    this.name = "ManifestError";
  }
}

/**
 * Parse a manifest file. Returns the parsed manifest, or `null` if the file
 * does not exist. Throws ManifestError on malformed TOML or schema violations.
 */
/** Conventional location of the workspace manifest within a repo. */
export const MANIFEST_REL_PATH = ".codecast/workspace.toml";

export function parseManifest(filePath: string): WorkspaceManifest | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf-8");
  return parseManifestText(text, filePath);
}

/** Parse a manifest from in-memory text (no filesystem). Used by tests. */
export function parseManifestText(text: string, filePath?: string): WorkspaceManifest {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ManifestError(`invalid TOML: ${msg}`, filePath);
  }
  if (!isPlainObject(raw)) {
    throw new ManifestError("manifest must be a TOML table", filePath);
  }
  return validate(raw, filePath);
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validate(raw: Record<string, unknown>, file?: string): WorkspaceManifest {
  const setup = validateSetup(raw["setup"], file);
  const ports = validatePorts(raw["ports"], file);
  const services = validateServices(raw["services"], file);
  const env = validateEnv(raw["env"], file);
  const teardown = validateTeardown(raw["teardown"], file);
  const verify = validateVerify(raw["verify"], file);
  const browser = validateBrowser(raw["browser"], file);
  const host = validateHost(raw["host"], file);
  const sync = validateSync(raw["sync"], file);
  const ship = validateShip(raw["ship"], file);
  const vault = validateVault(raw["vault"], file);
  const run = validateRun(raw["run"], file);

  // Reject unknown top-level keys so typos in manifest are surfaced loudly.
  const known = new Set([
    "setup", "ports", "services", "env", "teardown", "verify", "browser",
    "backend", "detected", "host", "sync", "ship", "vault", "run",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new ManifestError(`unknown top-level key '${key}'`, file, key);
    }
  }

  const detected = raw["detected"];
  if (detected !== undefined && typeof detected !== "string") {
    throw new ManifestError("'detected' must be a string", file, "detected");
  }

  const backendRaw = raw["backend"];
  if (backendRaw !== undefined && typeof backendRaw !== "string") {
    throw new ManifestError("'backend' must be a string", file, "backend");
  }
  const backend = backendRaw ?? "local";

  return { ...(run ? { run } : {}), ...(ship ? { ship } : {}), ...(host ? { host } : {}), ...(sync ? { sync } : {}), ...(vault ? { vault } : {}), setup, ports, services, env, teardown, ...(verify ? { verify } : {}), browser, backend, detected };
}

/** An apt package or systemd unit name: nothing a shell would read as more than one word. */
const HOST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.+:@_-]*$/;

function validateHost(raw: unknown, file?: string): HostSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ManifestError("'host' must be a table", file, "host");
  const known = new Set(["packages", "services", "run", "simulators", "memory_gb", "data"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ManifestError(`unknown key in [host]: '${key}'`, file, `host.${key}`);
  }
  const packages = validateStringArray(raw["packages"], "host.packages", file);
  const services = validateStringArray(raw["services"], "host.services", file);
  for (const [key, list] of [["packages", packages], ["services", services]] as const) {
    list.forEach((name, i) => {
      if (!HOST_NAME_RE.test(name)) throw new ManifestError(`'host.${key}[${i}]' is not a package or unit name`, file, `host.${key}[${i}]`);
    });
  }
  const simulators = validateStringArray(raw["simulators"], "host.simulators", file);
  simulators.forEach((name, i) => {
    if (!SIM_PLATFORMS.has(name)) throw new ManifestError(`'host.simulators[${i}]' must be one of ${[...SIM_PLATFORMS].join(", ")}`, file, `host.simulators[${i}]`);
  });
  const memory = raw["memory_gb"];
  if (memory !== undefined && (typeof memory !== "number" || !Number.isFinite(memory) || memory <= 0 || memory > 1024)) {
    throw new ManifestError("'host.memory_gb' must be a number of gigabytes", file, "host.memory_gb");
  }
  const data = validateStringArray(raw["data"], "host.data", file);
  data.forEach((entry, i) => {
    if (!dataFolderFromManifest(entry)) throw new ManifestError(`'host.data[${i}]' must be a folder under $HOME written ~/..., at least two levels deep and outside credential and agent folders`, file, `host.data[${i}]`);
  });
  return { packages, services, run: validateStringArray(raw["run"], "host.run", file), ...(simulators.length ? { simulators } : {}), ...(memory !== undefined ? { memory_gb: memory as number } : {}), ...(data.length ? { data } : {}) };
}

/** Simulator platforms a cloud Mac can be provisioned for (sim/provision.ts). */
const SIM_PLATFORMS = new Set(["iOS"]);

function validateSync(raw: unknown, file?: string): SyncSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ManifestError("'sync' must be a table", file, "sync");
  for (const key of Object.keys(raw)) {
    if (key !== "always" && key !== "never") throw new ManifestError(`unknown key in [sync]: '${key}'`, file, `sync.${key}`);
  }
  return { always: validateStringArray(raw["always"], "sync.always", file), never: validateStringArray(raw["never"], "sync.never", file) };
}

function validateShip(raw: unknown, file?: string): ShipSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ManifestError("'ship' must be a table", file, "ship");
  // A key a newer cast reads is ignored and named, not refused: refusing it broke `cast ws acquire` and every
  // station on each machine still running an older cast, so a repo could not use a new key until the whole fleet updated.
  const known = new Set(["mode", "check", "tests", "level", "deploy", "flow"]);
  const ignored = Object.keys(raw).filter((key) => !known.has(key));
  const mode = raw["mode"] ?? "pr";
  if (mode !== "pr" && mode !== "direct") throw new ManifestError("'ship.mode' must be \"pr\" or \"direct\"", file, "ship.mode");
  const check = raw["check"] ?? "cast check";
  if (typeof check !== "string") throw new ManifestError("'ship.check' must be a string", file, "ship.check");
  for (const key of ["tests", "level"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new ManifestError(`'ship.${key}' must be true or false`, file, `ship.${key}`);
  }
  const flow = raw["flow"];
  if (flow !== undefined && (typeof flow !== "string" || !flow.trim())) throw new ManifestError("'ship.flow' must name a flow", file, "ship.flow");
  if (typeof flow === "string" && flow.trim() === "default") throw new ManifestError("'ship.flow' must name the flow a pass ships through: shipping never takes a workspace's default flow", file, "ship.flow");
  const deployRaw = raw["deploy"] ?? [];
  if (!Array.isArray(deployRaw)) throw new ManifestError("'ship.deploy' must be an array of tables ([[ship.deploy]])", file, "ship.deploy");
  const deploy = deployRaw.map((step, i): ShipDeployStep => {
    const at = `ship.deploy[${i}]`;
    if (!isPlainObject(step)) throw new ManifestError(`'${at}' must be a table`, file, at);
    for (const key of Object.keys(step)) {
      if (!["name", "when", "run", "stage"].includes(key)) throw new ManifestError(`unknown key in [[ship.deploy]]: '${key}'`, file, `${at}.${key}`);
    }
    const run = step["run"];
    if (typeof run !== "string" || !run.trim()) throw new ManifestError(`'${at}.run' must be a non-empty string`, file, `${at}.run`);
    const stage = step["stage"] ?? "after_push";
    if (stage !== "before_push" && stage !== "after_push") throw new ManifestError(`'${at}.stage' must be "before_push" or "after_push"`, file, `${at}.stage`);
    const name = step["name"] ?? run.split(/\s+/)[0];
    if (typeof name !== "string") throw new ManifestError(`'${at}.name' must be a string`, file, `${at}.name`);
    const when = typeof step["when"] === "string" ? [step["when"]] : validateStringArray(step["when"], `${at}.when`, file);
    return { name, when, run, stage };
  });
  return { mode, check, tests: (raw["tests"] as boolean | undefined) ?? true, level: (raw["level"] as boolean | undefined) ?? false, deploy, ...(flow !== undefined ? { flow: (flow as string).trim() } : {}), ...(ignored.length ? { ignored } : {}) };
}

/** A repo-relative path or glob: no absolute paths, no `..`, nothing under .git. */
function validateRepoGlob(value: string, at: string, file?: string): void {
  if (!value || value.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(value) || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new ManifestError(`'${at}' must be a path or glob inside the repo`, file, at);
  }
}

function positiveNumber(raw: unknown, at: string, file?: string, max = Infinity): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > max) throw new ManifestError(`'${at}' must be a positive number`, file, at);
  return raw;
}

function validateRun(raw: unknown, file?: string): RunSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ManifestError("'run' must be a table", file, "run");
  const known = new Set(["install", "deps_key", "keep_deps", "max_upload_mb", "jobs"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ManifestError(`unknown key in [run]: '${key}'`, file, `run.${key}`);
  }
  const install = raw["install"] === undefined ? undefined : typeof raw["install"] === "string" ? [raw["install"]] : validateStringArray(raw["install"], "run.install", file);
  const depsKey = raw["deps_key"] === undefined ? undefined : validateStringArray(raw["deps_key"], "run.deps_key", file);
  depsKey?.forEach((g, i) => validateRepoGlob(g, `run.deps_key[${i}]`, file));
  const keepDeps = positiveNumber(raw["keep_deps"], "run.keep_deps", file, 100) ?? 3;
  if (!Number.isInteger(keepDeps)) throw new ManifestError("'run.keep_deps' must be a whole number", file, "run.keep_deps");
  const maxUploadMb = positiveNumber(raw["max_upload_mb"], "run.max_upload_mb", file, 100_000) ?? 50;
  const jobsRaw = raw["jobs"] ?? [];
  if (!Array.isArray(jobsRaw)) throw new ManifestError("'run.jobs' must be an array of tables ([[run.jobs]])", file, "run.jobs");
  const names = new Set<string>();
  const jobs = jobsRaw.map((job, i): RunJob => {
    const at = `run.jobs[${i}]`;
    if (!isPlainObject(job)) throw new ManifestError(`'${at}' must be a table`, file, at);
    for (const key of Object.keys(job)) {
      if (!["name", "argv", "outputs", "memory_gb", "timeout_min", "keep_daemons"].includes(key)) throw new ManifestError(`unknown key in [[run.jobs]]: '${key}'`, file, `${at}.${key}`);
    }
    const argv = typeof job["argv"] === "string" ? job["argv"].trim().split(/\s+/).filter(Boolean) : validateStringArray(job["argv"], `${at}.argv`, file);
    if (!argv.length || argv.some((w) => !w)) throw new ManifestError(`'${at}.argv' must name the command's leading words, like ["bun", "test"]`, file, `${at}.argv`);
    const name = job["name"] ?? argv.join(" ");
    if (typeof name !== "string" || !name.trim()) throw new ManifestError(`'${at}.name' must be a non-empty string`, file, `${at}.name`);
    if (names.has(name)) throw new ManifestError(`'${at}.name' repeats job '${name}'`, file, `${at}.name`);
    names.add(name);
    const outputs = validateStringArray(job["outputs"], `${at}.outputs`, file);
    outputs.forEach((g, j) => validateRepoGlob(g, `${at}.outputs[${j}]`, file));
    const memoryGb = positiveNumber(job["memory_gb"], `${at}.memory_gb`, file, 1024);
    const timeoutMin = positiveNumber(job["timeout_min"], `${at}.timeout_min`, file, 24 * 60);
    if (job["keep_daemons"] !== undefined && typeof job["keep_daemons"] !== "boolean") throw new ManifestError(`'${at}.keep_daemons' must be true or false`, file, `${at}.keep_daemons`);
    return { name, argv, outputs, ...(memoryGb !== undefined ? { memoryGb } : {}), ...(timeoutMin !== undefined ? { timeoutMin } : {}), ...(job["keep_daemons"] === true ? { keepDaemons: true } : {}) };
  });
  return { ...(install ? { install } : {}), ...(depsKey ? { depsKey } : {}), keepDeps, maxUploadMb, jobs };
}

/**
 * [vault]: `ENV_VAR = "secret-name"`, or `ENV_VAR = { secret = "secret-name",
 * required = true }` for one `cast dev` must not start without. Both names
 * follow the Vault's own rules; a bad line is refused naming its env var. The
 * right-hand side is never quoted back, since a pasted value lands there.
 */
function validateVault(raw: unknown, file?: string): Record<string, VaultBinding> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ManifestError(`[vault] must be a table of ENV_VAR = "secret-name" lines`, file, "vault");
  const out: Record<string, VaultBinding> = {};
  for (const [envVar, value] of Object.entries(raw)) {
    const refuse = (why: string): never => { throw new ManifestError(`[vault] ${envVar}: ${why}`, file, `vault.${envVar}`); };
    const envProblem = envNameProblem(envVar);
    if (envProblem) refuse(envProblem);
    const table = isPlainObject(value) ? value : null;
    const secret = table ? table["secret"] : value;
    if (typeof secret !== "string") refuse(`the value must be a secret name in quotes, or { secret = "name", required = true }`);
    if (table) {
      for (const key of Object.keys(table)) {
        if (key !== "secret" && key !== "required") refuse(`unknown key '${key}' (a line takes secret and required)`);
      }
      if (table["required"] !== undefined && typeof table["required"] !== "boolean") refuse("'required' must be true or false");
    }
    if (secretNameProblem(secret as string)) {
      refuse("the value is not a secret name: use 1 to 63 lowercase letters, digits and dashes, like stripe-test. A value itself goes in with cast vault add");
    }
    out[envVar] = { secret: secret as string, required: table?.["required"] === true };
  }
  return out;
}

function validateVerify(raw: unknown, file?: string): VerifySpec | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new ManifestError("'verify' must be a table", file, "verify");
  }
  for (const key of Object.keys(raw)) {
    if (key !== "command") {
      throw new ManifestError(`unknown key in [verify]: '${key}'`, file, `verify.${key}`);
    }
  }
  const command = raw["command"];
  if (command !== undefined && (typeof command !== "string" || !command.trim())) {
    throw new ManifestError("'verify.command' must be a non-empty string", file, "verify.command");
  }
  return command ? { command } : {};
}

function validateBrowser(raw: unknown, file?: string): BrowserSpec {
  if (raw === undefined) return { ...DEFAULT_BROWSER };
  if (!isPlainObject(raw)) {
    throw new ManifestError("'browser' must be a table", file, "browser");
  }
  const known = new Set(["enabled", "headless", "cdp_port", "allow"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new ManifestError(
        `unknown key in [browser]: '${key}'`,
        file,
        `browser.${key}`,
      );
    }
  }
  const enabled = raw["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new ManifestError("'browser.enabled' must be a boolean", file, "browser.enabled");
  }
  const headless = raw["headless"];
  if (headless !== undefined && typeof headless !== "boolean") {
    throw new ManifestError("'browser.headless' must be a boolean", file, "browser.headless");
  }
  // cdp_port (snake_case) → cdpPort (camelCase)
  let cdpPort: PortSpec = { ...DEFAULT_BROWSER.cdpPort };
  if (raw["cdp_port"] !== undefined) {
    if (!isPlainObject(raw["cdp_port"])) {
      throw new ManifestError(
        "'browser.cdp_port' must be a table {base,range}",
        file,
        "browser.cdp_port",
      );
    }
    const spec = raw["cdp_port"];
    const base = spec["base"];
    const range = spec["range"];
    if (typeof base !== "number" || !Number.isInteger(base) || base < 1 || base > 65535) {
      throw new ManifestError(
        "'browser.cdp_port.base' must be an integer 1..65535",
        file,
        "browser.cdp_port.base",
      );
    }
    if (typeof range !== "number" || !Number.isInteger(range) || range < 1) {
      throw new ManifestError(
        "'browser.cdp_port.range' must be a positive integer",
        file,
        "browser.cdp_port.range",
      );
    }
    cdpPort = { base, range };
  }
  // Absent and empty differ on purpose: no `allow` key means no site policy,
  // while `allow = []` locks the project down (see browser/policy.ts).
  const allow =
    raw["allow"] === undefined
      ? undefined
      : validateStringArray(raw["allow"], "browser.allow", file);
  return {
    enabled: enabled ?? DEFAULT_BROWSER.enabled,
    headless: headless ?? DEFAULT_BROWSER.headless,
    cdpPort,
    ...(allow !== undefined ? { allow } : {}),
  };
}

function validateSetup(raw: unknown, file?: string): SetupSpec {
  if (raw === undefined) {
    return { copy: [], share: [], install: [], generate: [], migrate: [] };
  }
  if (!isPlainObject(raw)) {
    throw new ManifestError("'setup' must be a table", file, "setup");
  }
  const known = new Set(["copy", "share", "install", "generate", "migrate"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new ManifestError(`unknown key in [setup]: '${key}'`, file, `setup.${key}`);
    }
  }
  return {
    copy: validateStringArray(raw["copy"], "setup.copy", file),
    share: validateStringArray(raw["share"], "setup.share", file),
    install: validateStringArray(raw["install"], "setup.install", file),
    generate: validateStringArray(raw["generate"], "setup.generate", file),
    migrate: validateStringArray(raw["migrate"], "setup.migrate", file),
  };
}

function validatePorts(
  raw: unknown,
  file?: string,
): Record<string, PortSpec> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new ManifestError("'ports' must be a table", file, "ports");
  }
  const out: Record<string, PortSpec> = {};
  for (const [name, spec] of Object.entries(raw)) {
    if (!isPlainObject(spec)) {
      throw new ManifestError(`port '${name}' must be a table`, file, `ports.${name}`);
    }
    const base = spec["base"];
    const range = spec["range"];
    if (typeof base !== "number" || !Number.isInteger(base) || base < 1 || base > 65535) {
      throw new ManifestError(
        `port '${name}': 'base' must be an integer 1..65535`,
        file,
        `ports.${name}.base`,
      );
    }
    if (typeof range !== "number" || !Number.isInteger(range) || range < 1) {
      throw new ManifestError(
        `port '${name}': 'range' must be a positive integer`,
        file,
        `ports.${name}.range`,
      );
    }
    const known = new Set(["base", "range"]);
    for (const key of Object.keys(spec)) {
      if (!known.has(key)) {
        throw new ManifestError(
          `unknown key in port '${name}': '${key}'`,
          file,
          `ports.${name}.${key}`,
        );
      }
    }
    out[name] = { base, range };
  }
  return out;
}

function validateServices(
  raw: unknown,
  file?: string,
): Record<string, ServiceSpec> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new ManifestError("'services' must be a table", file, "services");
  }
  const out: Record<string, ServiceSpec> = {};
  for (const [name, spec] of Object.entries(raw)) {
    if (!isPlainObject(spec)) {
      throw new ManifestError(
        `service '${name}' must be a table`,
        file,
        `services.${name}`,
      );
    }
    const mode = spec["mode"];
    if (mode !== "shared" && mode !== "isolated") {
      throw new ManifestError(
        `service '${name}': 'mode' must be 'shared' or 'isolated'`,
        file,
        `services.${name}.mode`,
      );
    }
    const out_: ServiceSpec = { mode };
    assignOptString(out_, "start", spec["start"], file, name);
    assignOptString(out_, "stop", spec["stop"], file, name);
    assignOptString(out_, "url", spec["url"], file, name);
    // ready_check (TOML snake_case) → readyCheck (TS camelCase)
    assignOptString(out_, "readyCheck", spec["ready_check"], file, name);
    assignOptString(out_, "port", spec["port"], file, name);
    const rtsRaw = spec["ready_timeout_sec"];
    if (rtsRaw !== undefined) {
      if (typeof rtsRaw !== "number" || !Number.isInteger(rtsRaw) || rtsRaw <= 0) {
        throw new ManifestError(
          `service '${name}': 'ready_timeout_sec' must be a positive integer`,
          file,
          `services.${name}.ready_timeout_sec`,
        );
      }
      out_.readyTimeoutSec = rtsRaw;
    }

    // Validate keys
    const known = new Set([
      "mode", "start", "stop", "url", "ready_check", "port", "ready_timeout_sec",
    ]);
    for (const key of Object.keys(spec)) {
      if (!known.has(key)) {
        throw new ManifestError(
          `unknown key in service '${name}': '${key}'`,
          file,
          `services.${name}.${key}`,
        );
      }
    }

    // Cross-field requirements
    if (mode === "shared" && !out_.url) {
      throw new ManifestError(
        `service '${name}': mode='shared' requires 'url'`,
        file,
        `services.${name}.url`,
      );
    }
    if (mode === "isolated" && !out_.start) {
      throw new ManifestError(
        `service '${name}': mode='isolated' requires 'start'`,
        file,
        `services.${name}.start`,
      );
    }

    out[name] = out_;
  }
  return out;
}

function validateEnv(raw: unknown, file?: string): Record<string, string> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new ManifestError("'env' must be a table", file, "env");
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val !== "string") {
      throw new ManifestError(
        `env.${key} must be a string (TOML strings can be quoted)`,
        file,
        `env.${key}`,
      );
    }
    out[key] = val;
  }
  return out;
}

function validateTeardown(raw: unknown, file?: string): TeardownSpec {
  if (raw === undefined) return { run: [] };
  if (!isPlainObject(raw)) {
    throw new ManifestError("'teardown' must be a table", file, "teardown");
  }
  const known = new Set(["run"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new ManifestError(
        `unknown key in [teardown]: '${key}'`,
        file,
        `teardown.${key}`,
      );
    }
  }
  return { run: validateStringArray(raw["run"], "teardown.run", file) };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validateStringArray(raw: unknown, path: string, file?: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ManifestError(`'${path}' must be an array of strings`, file, path);
  }
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== "string") {
      throw new ManifestError(
        `'${path}[${i}]' must be a string`,
        file,
        `${path}[${i}]`,
      );
    }
  }
  return raw as string[];
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function assignOptString<K extends keyof ServiceSpec>(
  target: ServiceSpec,
  key: K,
  value: unknown,
  file: string | undefined,
  serviceName: string,
): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new ManifestError(
      `service '${serviceName}': '${String(key)}' must be a string`,
      file,
      `services.${serviceName}.${String(key)}`,
    );
  }
  (target as unknown as Record<string, unknown>)[key as string] = value;
}
