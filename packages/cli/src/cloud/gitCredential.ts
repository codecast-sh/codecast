/**
 * `cast git-credential` — the cloud host's GitHub password, minted per call.
 *
 * git speaks a tiny protocol to a credential helper: it writes `key=value`
 * lines on stdin, ends them with a blank line, and reads `username=` and
 * `password=` lines back. That is the whole contract here. The password is a
 * GitHub App installation token the server mints for this device and this
 * repository (convex cloud.hostGitCredential), it expires within the hour, and
 * nothing writes it to disk — it goes to git's stdin protocol and the process
 * exits.
 *
 * A refusal is silence: no output and a non-zero exit, which is how git is
 * told "I have nothing" so it falls through to the next helper. Printing the
 * reason would put it in the middle of git's own output on every fetch, and an
 * agent reading that would treat a working repository as broken. `--why` is
 * there for a human asking the same question on purpose.
 *
 * Only github.com, and only the `get` operation: `store` and `erase` are
 * accepted and do nothing, because the credential is not ours to keep and
 * expires on its own.
 *
 * Stdout is an OUTPUT PROTOCOL, which is why git invokes this verb through
 * fastPath.ts and not through the CLI's own lifecycle: git reads the helper's
 * first line as `username=`, so one line of anything else — the auto-update
 * notice the full CLI prints on stdout when a release is pending — makes git
 * throw the whole credential away and fail with "could not read Username".
 * Every entry point here therefore writes the credential and nothing else.
 */

import type { Command } from "commander";
import { commandGroup } from "../commandGroups.js";
import { githubRepo, parseOrigin } from "./gitOrigin.js";

/** One credential request, as git spells it on stdin. */
export type CredentialQuery = Record<string, string>;

export interface HostCredential {
  username: string;
  password: string;
  expires_at?: number;
}

export type CredentialAnswer = HostCredential | { reason: string };

export interface GitCredentialDeps {
  /** git's request on stdin. */
  readInput: () => Promise<string>;
  /** Ask the server for this repository's token. */
  fetchCredential: (q: { host: string; repository: string }) => Promise<CredentialAnswer>;
  /** The origin of the repository git is working in, for a request that names no path. */
  originRepository?: () => Promise<string | undefined> | string | undefined;
  write: (text: string) => void;
  /** Where `--why` explains itself; never the credential. */
  explain?: (text: string) => void;
}

/**
 * git's request. Values run to the end of the line, keys repeat for list
 * attributes (`wwwauth[]`), and a blank line ends the request — everything
 * after it belongs to no request and is ignored. A line without `=`, and any
 * value carrying a NUL, is dropped rather than guessed at.
 */
export function parseCredentialInput(input: string): CredentialQuery {
  const out: CredentialQuery = {};
  for (const line of input.split("\n")) {
    if (line === "" || line === "\r") break;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).replace(/\r$/, "");
    if (value.includes("\0") || key.includes("\0")) continue;
    // A repeated key keeps the FIRST value, which is git's own rule for the
    // single-valued attributes; list attributes (`wwwauth[]`) go unread.
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * The `owner/name` the request is about.
 *
 * git sends `path=` only with `credential.useHttpPath` on, which the host
 * configures (hostGit.ts) precisely so the helper can tell which installation
 * to ask for. Where it is off, the repository git is standing in answers the
 * same question — helpers run with the repository as their working directory.
 */
export async function credentialRepository(
  q: CredentialQuery,
  originRepository?: GitCredentialDeps["originRepository"],
): Promise<string | undefined> {
  const fromPath = q.path ? repositoryFromPath(q.path) : undefined;
  if (fromPath) return fromPath;
  const origin = await originRepository?.();
  return origin ? githubRepo(origin) : undefined;
}

function repositoryFromPath(path: string): string | undefined {
  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  return parts.length === 2 && parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p)) ? parts.join("/") : undefined;
}

/**
 * What git reads back. `password_expiry_utc` lets git 2.41 and newer drop the
 * token the second it expires instead of retrying with it; older versions
 * ignore lines they do not know.
 */
export function formatCredential(c: HostCredential): string {
  const lines = [`username=${c.username}`, `password=${c.password}`];
  if (typeof c.expires_at === "number" && Number.isFinite(c.expires_at)) {
    lines.push(`password_expiry_utc=${Math.floor(c.expires_at / 1000)}`);
  }
  return lines.join("\n") + "\n";
}

export interface GitCredentialOptions {
  /** Print the reason a request was refused instead of exiting silently. */
  why?: boolean;
}

/**
 * One run of the helper. Returns git's exit code: 0 when the request was
 * answered or was none of our business, 1 when we have no credential for it.
 */
export async function runGitCredential(
  operation: string | undefined,
  deps: GitCredentialDeps,
  opts: GitCredentialOptions = {},
): Promise<number> {
  const refuse = (reason: string): number => {
    if (opts.why) (deps.explain ?? deps.write)(`${reason}\n`);
    return 1;
  };
  // store and erase are accepted and do nothing: the token expires on its own
  // and was never ours to keep. An operation git invents later is the same.
  if (operation !== "get") return 0;

  const q = parseCredentialInput(await deps.readInput());
  if (q.protocol && q.protocol !== "https") return refuse(`${q.protocol} is not https — an installation token is an http credential`);
  if (q.host !== "github.com") return refuse(`${q.host || "this host"} is not github.com`);
  const repository = await credentialRepository(q, deps.originRepository);
  if (!repository) {
    return refuse("the request names no repository — set credential.useHttpPath, or run this inside the repository");
  }
  // The deps are injected, so a throw here would reach commander and print a
  // stack trace into the middle of git's output. A failure is a refusal.
  let answer: CredentialAnswer;
  try {
    answer = await deps.fetchCredential({ host: q.host, repository });
  } catch (e) {
    return refuse((e as Error)?.message || "the credential could not be fetched");
  }
  if (!answer || "reason" in answer) return refuse(answer?.reason ?? "the credential could not be fetched");
  deps.write(formatCredential(answer));
  return 0;
}

// ---------------------------------------------------------------------------
// The real deps
// ---------------------------------------------------------------------------

/** stdin to the end, as git wrote it. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

/** The origin of the repository git invoked the helper from, if it is in one. */
async function originHere(): Promise<string | undefined> {
  const { spawnSync } = await import("../proc.js");
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8", stdio: "pipe", timeout: 10_000 });
  const url = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return url && parseOrigin(url) ? url : undefined;
}

/**
 * How long the server gets to answer before the helper gives up.
 *
 * git cannot interrupt a credential helper, so a stalled endpoint stalls the
 * git command itself, and on a host whose origin is https there is no second
 * credential waiting behind us. A refusal inside the budget turns that into an
 * ordinary authentication failure, which an agent can read and act on, instead
 * of a fetch that never returns. The pending request is abandoned, not awaited:
 * the process exits as soon as git has its answer.
 */
export const CREDENTIAL_BUDGET_MS = 15_000;

export function withBudget<T>(work: Promise<T>, ms: number = CREDENTIAL_BUDGET_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the server did not answer within ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

/**
 * Ask the server. Every failure — no config, no network, an endpoint an older
 * deployment does not have — is one reason, because git only needs to know
 * that this helper has nothing.
 */
async function requestCredential(q: { host: string; repository: string }): Promise<CredentialAnswer> {
  try {
    const [{ convexClient }, { deviceId }] = await Promise.all([
      import("../remote/convexClient.js"),
      import("../remote/device.js"),
    ]);
    const { client, token, api } = await convexClient();
    const answer: any = await withBudget<any>(
      client.action(api.cloud.hostGitCredential, {
        api_token: token,
        device_id: deviceId(),
        repository: q.repository,
        host: q.host,
      }),
    );
    if (!answer || typeof answer !== "object") return { reason: "the server answered nothing" };
    if ("reason" in answer) return { reason: String(answer.reason) };
    return { username: String(answer.username), password: String(answer.password), expires_at: Number(answer.expires_at) };
  } catch (e) {
    return { reason: (e as Error).message || "the server could not be reached" };
  }
}

/** The real deps, wired once: the fast path and the command below share them. */
function hostDeps(): GitCredentialDeps {
  return {
    readInput: readStdin,
    fetchCredential: requestCredential,
    originRepository: originHere,
    write: (text) => process.stdout.write(text),
    explain: (text) => process.stderr.write(text),
  };
}

/**
 * git's own entry point (fastPath.ts). Answers, flushes, and exits — never
 * returns, because the abandoned request after a budget expiry would otherwise
 * hold the process open long after git has moved on.
 */
export async function runHostGitCredential(operation: string | undefined): Promise<never> {
  let code = 1;
  try {
    code = await runGitCredential(operation, hostDeps());
  } catch {
    code = 1;
  }
  // stdout is a pipe here, so the last write may still be buffered.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(code);
}

export function registerGitCredentialCommand(program: Command): void {
  program
    .command("git-credential", { hidden: true })
    .argument("[operation]", "get, store or erase — git supplies it")
    .option("--why", "print why a request is refused instead of exiting quietly")
    .description(commandGroup("git-credential").description)
    .action(async (operation: string | undefined, o: { why?: boolean }) => {
      // `--why` and a human typing the verb land here; git itself never does
      // (fastPath.ts claims `cast git-credential <operation>` before the CLI
      // loads), so the update notice this lifecycle can print costs nothing.
      process.exitCode = await runGitCredential(operation, hostDeps(), { why: o.why === true });
    });
}
