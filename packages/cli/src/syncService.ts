import { ConvexHttpClient, ConvexClient } from "convex/browser";
import { readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { hashImageBytes, lookupByHash, lookupByPath, storeUpload } from "./imageCache.js";
import { countingSemaphore } from "./semaphore.js";
import { redactSecrets } from "./redact.js";
import { deviceId } from "./remote/device.js";
import { hashPath } from "./hash.js";
import type { OpenTaskReport, AgentStatus } from "@codecast/shared/contracts";

const MAX_CONTENT_SIZE = 100_000;
const MAX_TOOL_RESULT_SIZE = 50_000;
// Max serialized bytes of one addMessages batch (~0.9MB, well under the 5MB
// that triggered isolate OOM/timeouts in the 2026-05-13 stuck-sync incident).
const MAX_BATCH_BYTES = 900_000;
export const MAX_IMAGE_SIZE = 5_000_000;

// Markdown image/link whose target is an absolute (or ~/) local path with a
// raster extension — the "dead screenshot link" shape rescueLocalImageLinks
// rewrites. Groups: (1) opener through "(", (2) the path, (3) ")".
const LOCAL_IMAGE_LINK_RE = /(!?\[[^\]\n]*\]\()((?:\/|~\/)[^)\s]+?\.(?:png|jpe?g|gif|webp|avif|bmp))(\))/gi;
const MAX_LINK_RESCUES_PER_MESSAGE = 8;
// Browser-renderable raster types (tiff sniffs but doesn't render; svg is a
// script vector when served for direct navigation).
const RESCUABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);
const MAX_INLINE_IMAGE_SIZE = 500_000;
const MAX_IMAGES_PER_MESSAGE = 10;
// Upload images concurrently rather than one-at-a-time. Uploads go to file storage
// (not the conversation hot-doc), so they don't contend on OCC; serializing them
// made an image-heavy sync chunk slower than the live file grew, so the session
// never caught up. Bounded so a burst can't stampede the backend.
const IMAGE_UPLOAD_CONCURRENCY = 6;

const MIN_REQUEST_INTERVAL_MS = 100;

// A batch is byte-bounded at MAX_BATCH_BYTES (~0.9MB), so a healthy backend
// commits one in low single-digit seconds — the only reason a ~0.9MB mutation
// sits past ~25-30s is a SATURATED backend, where waiting the rest of the way to
// 60s won't help it commit; it just holds the per-conversation write-chain
// (withConversationLock) hostage for a full minute, freezing that conversation's
// web view. Fail over at 28s so a saturated mutation releases the chain ~2x
// faster and the op re-queues for the recovery-drain path. This is comfortably
// above the healthy commit time, so it never times out a legitimately-large
// batch that would have landed — those are already split by MAX_BATCH_BYTES.
// Image uploads keep their own (separate) UPLOAD_IMAGE_TIMEOUT_MS budget.
const ADD_MESSAGES_BATCH_TIMEOUT_MS = 28_000;
const ADD_MESSAGES_BATCH_SIZE = 25;
// uploadImage runs *before* the timed addMessages batch, so an un-timed upload
// hang (slow network / contended backend) wedges the whole chunk: the file-watcher
// can't advance its position past the image message and every later turn stops
// syncing. Time-box each network leg so a stuck upload degrades to null (the caller
// then inlines small images or drops oversized ones) instead of freezing the session.
const UPLOAD_IMAGE_TIMEOUT_MS = 30_000;

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AuthExpiredError extends Error {
  constructor(message: string = "Authentication token expired") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... [truncated ${str.length - maxLen} chars]`;
}

export function detectImageMediaType(data: Buffer): string | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return "image/bmp";
  }
  if (
    data.length >= 4 &&
    (
      (data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00) ||
      (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a)
    )
  ) {
    return "image/tiff";
  }
  if (
    data.length >= 12 &&
    data.subarray(4, 8).toString("ascii") === "ftyp" &&
    ["avif", "avis"].includes(data.subarray(8, 12).toString("ascii"))
  ) {
    return "image/avif";
  }
  const textPrefix = data.subarray(0, Math.min(data.length, 1024)).toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/i.test(textPrefix)) {
    return "image/svg+xml";
  }
  return null;
}

function decodeImageBase64(base64Data: string): { data: Buffer; mediaType: string } | null {
  const normalized = base64Data.replace(/\s/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    return null;
  }
  const data = Buffer.from(normalized, "base64");
  const roundTrip = data.toString("base64").replace(/=+$/, "");
  if (roundTrip !== normalized.replace(/=+$/, "")) return null;
  const mediaType = detectImageMediaType(data);
  return mediaType ? { data, mediaType } : null;
}

/**
 * Split prepared messages into mutation-sized batches, bounded by BOTH message
 * count and serialized byte size. The byte bound is what stops a handful of
 * image-heavy messages (large inline base64) from forming a multi-MB mutation
 * that can't commit within the timeout/isolate budget. A single message that
 * alone exceeds the byte cap is emitted in its own batch — one message can't be
 * split, and one ~MAX_INLINE_IMAGE_SIZE message commits fine on its own.
 */
export function chunkMessagesBySize<T>(
  messages: T[],
  maxCount: number = ADD_MESSAGES_BATCH_SIZE,
  maxBytes: number = MAX_BATCH_BYTES,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const msg of messages) {
    const bytes = Buffer.byteLength(JSON.stringify(msg));
    if (current.length > 0 && (current.length >= maxCount || currentBytes + bytes > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(msg);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function isAuthError(error: any): boolean {
  const message = (error?.message || String(error)).toLowerCase();

  // Skip transient server errors - these are NOT auth errors
  if (
    message.includes("server error") ||
    message.includes("request id:") ||
    message.includes("optimisticconcurrencycontrolfailure") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("econnrefused") ||
    message.includes("econnreset")
  ) {
    return false;
  }

  // Only match definitive auth errors, not generic "unauthorized"
  return (
    message.includes("invalid token") ||
    message.includes("token expired") ||
    message.includes("token not found") ||
    message.includes("authentication failed") ||
    (message.includes("auth") && message.includes("expired"))
  );
}

export type AgentType = "claude_code" | "codex" | "cursor" | "gemini" | "opencode" | "pi" | "grok";

export interface SyncConfig {
  convexUrl: string;
  authToken?: string;
  userId?: string;
}

export interface PendingMessageForDelivery {
  _id: string;
  conversation_id: string;
  from_user_id: string;
  content: string;
  image_storage_id?: string;
  image_storage_ids?: string[];
  client_id?: string;
  status: string;
  created_at: number;
  delivered_at?: number;
  retry_count: number;
}

export type ExecutionControlMutationName =
  | "registerExecutionDaemonBoot"
  | "beginLegacyQuiescence"
  | "initializeFencedExecution"
  | "activateAfterLegacyQuiescence"
  | "requestExecutionSuccessor"
  | "claimExecutionStart"
  | "publishReadyBinding"
  | "publishStartFailedBeforeEffect"
  | "publishStartAmbiguous"
  | "disposePreReadyBinding"
  | "claimNextDelivery"
  | "rejectHeadDelivery"
  | "startDelivery"
  | "releaseClaimBeforeEffect"
  | "completeDelivery"
  | "failDeliveryBeforeEffect"
  | "markDeliveryAmbiguous"
  | "resolveAmbiguousDelivery"
  | "abandonAmbiguousAndResend"
  | "publishRuntimeDisposition"
  | "activateExecutionSuccessor";

export type ExecutionControlQueryName = "getExecutionAuthority" | "listExecutionWork";

/**
 * A conversation's own lifecycle + inbox visibility, as far as the daemon can
 * see it. `source` is load-bearing, not decoration — the two sources are NOT
 * interchangeable, and a caller that treats them as such gets a wrong answer:
 *
 *  - "lifecycle": the real query, resolved by CONVERSATION ID (an exact
 *    ctx.db.get), carrying every field. `hideStateKnown` is true.
 *  - "status-fallback": devices:resolveConversationBySession, which resolves by
 *    SESSION ID with `.first()` — the OLDEST twin (this repo's ct-36973
 *    foot-gun). It carries `status` only, so `hideStateKnown` is false, and with
 *    twins the status may belong to the wrong row in either direction.
 *
 * An absent hide field means "not known", never "not set" — read `hideStateKnown`
 * before believing any of them.
 */
export interface ConversationLifecycle {
  status?: string | null;
  inboxKilledAt?: number | null;
  inboxStashedAt?: number | null;
  inboxDismissedAt?: number | null;
  inboxPinnedAt?: number | null;
  /** True only when the hide fields were actually fetched (source === "lifecycle"). */
  hideStateKnown: boolean;
  source: "lifecycle" | "status-fallback";
}

// An undeployed Convex function is a PERMANENT condition; a DNS blip, a 502 or a
// sleep-killed socket is not. Latching the query off on the latter silently
// degrades the resurrection gate and makes the reap hide-gate misclassify for the
// rest of the daemon's life, so we match the missing-function shape narrowly and
// treat everything else as transient.
export function isMissingFunctionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /could not find (public )?function|function not found|no such function/i.test(msg);
}

// 0 = believed available. Set to the failure time when the function is missing;
// a re-probe past LIFECYCLE_REPROBE_MS heals a latch that was wrong (or that a
// deploy has since fixed) without waiting for a daemon restart.
let lifecycleQueryMissingSince = 0;
const LIFECYCLE_REPROBE_MS = 6 * 60 * 60 * 1000;

export function shouldProbeLifecycleQuery(
  missingSince: number,
  now: number,
  reprobeMs: number = LIFECYCLE_REPROBE_MS,
): boolean {
  if (missingSince === 0) return true;
  return now - missingSince >= reprobeMs;
}

/** Test seam: forget the latch so each case starts from a known state. */
export function resetLifecycleQueryLatch(): void {
  lifecycleQueryMissingSince = 0;
}

export interface GitInfo {
  commitHash?: string;
  branch?: string;
  remoteUrl?: string;
  status?: string;
  diff?: string;
  diffStaged?: string;
  root?: string;
  repoRoot?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  worktreePath?: string;
}

export interface CreateConversationParams {
  userId: string;
  teamId?: string;
  sessionId: string;
  agentType: AgentType;
  projectPath?: string;
  slug?: string;
  title?: string;
  startedAt?: number;
  parentMessageUuid?: string;
  parentConversationId?: string;
  gitCommitHash?: string;
  gitInfo?: GitInfo;
  cliFlags?: string;
  subagentDescription?: string;
  // Transcript path says subagents/ — assert it even when the parent
  // conversation isn't resolvable yet, so the server never treats the row as
  // a human-started session (teammate start notifications).
  isSubagent?: boolean;
  // Agent-team stamps from a teammate's JSONL (see parser.extractTeamInfo).
  agentTeamName?: string;
  agentName?: string;
}

export class SyncService {
  private client: ConvexHttpClient;
  // Lazy: ConvexClient opens its websocket at construction and reconnects
  // forever. Only the daemon's live-subscription path (one call site) needs
  // it — creating it eagerly meant every SyncService a TEST constructs leaked
  // an immortal ws://…:0 reconnect loop that outlived the test file and
  // spammed the suite (and bun's exit code) long after.
  private subscriptionClient?: ConvexClient;
  private convexUrl: string;
  private userId?: string;
  private apiToken?: string;
  private lastRequestTime = 0;
  private throttleQueue: Promise<void> = Promise.resolve();
  // Per-network-leg deadline for image uploads. A field (not the bare constant)
  // only so tests can shorten it; production always uses UPLOAD_IMAGE_TIMEOUT_MS.
  private imageUploadTimeoutMs = UPLOAD_IMAGE_TIMEOUT_MS;
  // App-server progress is re-materialized after every item, so the same local
  // image path can be seen repeatedly during one turn. Reuse its storage object
  // while the file's size/mtime are unchanged.
  private localImageUploads = new Map<string, {
    size: number;
    mtimeMs: number;
    mediaType: string;
    storageId: string;
  }>();
  // Serializes addMessages per conversation. The server's addMessages reads+patches
  // the conversation document on every batch, so two addMessages for the SAME
  // conversation running at once collide on that one doc — Convex OCC-retries the
  // loser, and under sustained concurrency (live file-watch sync + the watchdog +
  // reconciliation + the retry queue all targeting one active conversation) a write
  // can retry-starve past the 60s client timeout, re-queue, and snowball into a
  // permanent "sync stalled". Different conversations write different docs and stay
  // fully parallel; only same-conversation writes are chained.
  private conversationWriteChains = new Map<string, Promise<unknown>>();

  constructor(config: SyncConfig) {
    this.client = new ConvexHttpClient(config.convexUrl);
    this.convexUrl = config.convexUrl;
    this.userId = config.userId;
    this.apiToken = config.authToken;
  }

  // Every daemon mutation must bypass ConvexHttpClient's built-in mutation
  // queue (mutations are FIFO-serialized per client instance by default).
  // Ordering is already ours: same-conversation writes chain through
  // withConversationLock and each flow awaits its own calls, so the client's
  // global queue adds nothing — and it caps the whole daemon at one mutation
  // in flight. Under a backlog burst (post-sleep, backend brownout) queue
  // wait exceeds ADD_MESSAGES_BATCH_TIMEOUT_MS, so callers time out while
  // their abandoned entries still run, retries re-enqueue duplicates, and
  // sync clogs against a perfectly healthy backend.
  private mutate(name: string, args: Record<string, unknown>): Promise<any> {
    return this.client.mutation(name as any, args, { skipQueue: true });
  }

  private async throttle(): Promise<void> {
    const ticket = this.throttleQueue.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
      }
      this.lastRequestTime = Date.now();
    });
    this.throttleQueue = ticket;
    await ticket;
  }

  getClient(): ConvexHttpClient {
    return this.client;
  }

  /** Storage URL for an uploaded image, authed via api_token (the daemon's
   * client has no cookie session — unauthenticated callers get null). */
  async getImageUrl(storageId: string): Promise<string | null> {
    return await this.client.query("images:getImageUrl" as any, {
      storageId,
      api_token: this.apiToken,
    });
  }

  getSubscriptionClient(): ConvexClient {
    if (!this.subscriptionClient) {
      this.subscriptionClient = new ConvexClient(this.convexUrl);
    }
    return this.subscriptionClient;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  setApiToken(token: string): void {
    this.apiToken = token;
  }

  private executionApiToken(): string {
    if (!this.apiToken) {
      throw new AuthExpiredError("Fenced execution requires the daemon API token");
    }
    return this.apiToken;
  }

  // Maps auth failures to AuthExpiredError; every other error passes through.
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isAuthError(error)) throw new AuthExpiredError();
      throw error;
    }
  }

  /**
   * Narrow transport used by ConvexExecutionControlPlane. It always supplies
   * the daemon bearer explicitly; there is no browser/session auth fallback and
   * no call can enter ConvexHttpClient's ambient mutation queue.
   */
  async executionControlMutation(
    name: ExecutionControlMutationName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.guarded(() =>
      this.mutate(`executionBindings:${name}`, {
        ...args,
        api_token: this.executionApiToken(),
      })
    );
  }

  async executionControlQuery(
    name: ExecutionControlQueryName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.guarded(() =>
      this.client.query(`executionBindings:${name}` as any, {
        ...args,
        api_token: this.executionApiToken(),
      })
    );
  }

  subscribeExecutionControlQuery(
    name: ExecutionControlQueryName,
    args: Record<string, unknown>,
    onUpdate: (value: unknown) => void,
  ): () => void {
    return this.getSubscriptionClient().onUpdate(
      `executionBindings:${name}` as any,
      { ...args, api_token: this.executionApiToken() },
      onUpdate,
    );
  }

  // Enqueue a user-authored message onto a conversation's delivery rail (the
  // same pending_messages path the web composer uses). The daemon calls this
  // after switch_account recycles a blocked session: the pending message is
  // what triggers the auto-resume that adopts the freshly swapped credential.
  async enqueueUserMessage(conversationId: string, content: string, clientId?: string): Promise<void> {
    await this.throttle();
    await this.mutate("pendingMessages:sendMessageToSession" as any, {
      conversation_id: conversationId,
      content,
      client_id: clientId,
      api_token: this.apiToken,
    });
  }

  // After this (primary) daemon pushes a CHANGED credential to the remote
  // Macs, nudge their auth-blocked sessions with "continue" — CC re-reads the
  // credential store on its next turn, so the nudge is the whole recovery.
  // Selection (auth-kind, remote owners, recent window) lives server-side.
  async reviveRemoteAuthBlocked(): Promise<number> {
    await this.throttle();
    const res = await this.mutate("accountSwitch:reviveAuthBlockedOnRemotes" as any, {
      api_token: this.apiToken,
    });
    return res?.continued ?? 0;
  }

  // Report the browser sign-in flow's outcome (start_login command). Confirmed
  // also makes the server kick off the auth-blocked revive; the returned count
  // is how many sessions it queued.
  // Setup-token mint flow status (the web's reactive channel, mirrors
  // completeLoginFlow). "pending" is stamped by the daemon itself for
  // auto-mints; web-requested mints arrive already pending.
  async reportMintFlow(
    status: "pending" | "confirmed" | "rejected",
    profile: string,
    email?: string,
    reason?: string,
  ): Promise<void> {
    await this.throttle();
    await this.mutate("accountSwitch:reportMintFlow" as any, {
      api_token: this.apiToken,
      device_id: deviceId(),
      status,
      profile,
      ...(email ? { email } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  async completeLoginFlow(
    status: "confirmed" | "rejected",
    email?: string,
    reason?: string,
  ): Promise<number> {
    await this.throttle();
    const res = await this.mutate("accountSwitch:completeLoginFlow" as any, {
      api_token: this.apiToken,
      device_id: deviceId(),
      status,
      ...(email ? { email } : {}),
      ...(reason ? { reason } : {}),
    });
    return res?.revived ?? 0;
  }

  private async existingMessageUuids(conversationId: string, messageUuids: string[]): Promise<Set<string> | null> {
    if (messageUuids.length === 0) return new Set();
    await this.throttle();
    try {
      return await this.guarded(async () => {
        const existing = await this.client.query(
          "messages:existingMessageUuids" as any,
          {
            conversation_id: conversationId,
            message_uuids: messageUuids,
            api_token: this.apiToken,
          }
        );
        return new Set(Array.isArray(existing) ? existing : []);
      });
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      return null;
    }
  }

  // Offload large inline images to Convex storage *before* the messages enter
  // the send path or the retry queue, mutating each message's images in place:
  // a successful upload replaces `data` with `storageId`; an upload that fails
  // for an image too big to inline is dropped. This is what keeps the retry
  // queue small (it used to persist 682KB of raw base64 per stuck op → a 16MB
  // queue file) and stops every retry from re-uploading the same image. Idempotent:
  // images that already carry a storageId are left untouched.
  async offloadImages(
    messages: Array<{ images?: Array<{ mediaType: string; data?: string; localPath?: string; storageId?: string; toolUseId?: string }> }>,
  ): Promise<void> {
    type Img = { mediaType: string; data?: string; localPath?: string; storageId?: string; toolUseId?: string };

    // Uploads run with bounded concurrency across the whole batch instead of
    // one image at a time.
    const uploads = countingSemaphore(IMAGE_UPLOAD_CONCURRENCY);

    // Resolve a single image to its persisted form (or null = drop). Order-preserving
    // because callers map over the original array.
    const resolveImage = async (img: Img): Promise<Img | null> => {
      if (img.storageId) return img;

      let candidate = img;
      let localFile: { path: string; size: number; mtimeMs: number } | undefined;
      if (img.localPath) {
        try {
          const fileStat = await stat(img.localPath);
          if (!fileStat.isFile()) {
            console.warn(`[SyncService] Local image is not a file: ${img.localPath}`);
            return null;
          }
          if (fileStat.size > MAX_IMAGE_SIZE) {
            console.warn(`[SyncService] Local image too large: ${fileStat.size} bytes > ${MAX_IMAGE_SIZE}`);
            return null;
          }
          const cached = this.localImageUploads.get(img.localPath);
          if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
            return {
              mediaType: cached.mediaType,
              storageId: cached.storageId,
              toolUseId: img.toolUseId,
            };
          }
          const bytes = await readFile(img.localPath);
          const detectedMediaType = detectImageMediaType(bytes);
          if (!detectedMediaType) {
            console.warn(`[SyncService] Local image has an unsupported or invalid payload: ${img.localPath}`);
            return null;
          }
          candidate = {
            mediaType: detectedMediaType,
            data: bytes.toString("base64"),
            toolUseId: img.toolUseId,
          };
          localFile = {
            path: img.localPath,
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
          };
        } catch (err) {
          console.warn(`[SyncService] Failed to read local image ${img.localPath}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }

      if (!candidate.data) return null;
      const data = candidate.data;
      const storageId = await uploads.run(() => this.uploadImage(data, candidate.mediaType));
      if (storageId) {
        if (localFile) {
          this.localImageUploads.set(localFile.path, {
            size: localFile.size,
            mtimeMs: localFile.mtimeMs,
            mediaType: candidate.mediaType,
            storageId,
          });
        }
        return {
          mediaType: candidate.mediaType,
          storageId,
          toolUseId: candidate.toolUseId,
        };
      }
      const decoded = decodeImageBase64(candidate.data);
      if (!decoded) {
        console.warn("[SyncService] Image dropped at offload: invalid image payload");
        return null;
      }
      const dataBytes = decoded.data.length;
      if (dataBytes <= MAX_INLINE_IMAGE_SIZE) {
        return {
          mediaType: decoded.mediaType,
          data: candidate.data,
          toolUseId: candidate.toolUseId,
        };
      }
      console.warn(`[SyncService] Image dropped at offload: upload failed and too large for inline (${dataBytes} bytes)`);
      return null;
    };

    await Promise.all(
      messages.map(async (msg) => {
        if (!msg.images || msg.images.length === 0) return;
        const resolved = await Promise.all(
          msg.images.slice(0, MAX_IMAGES_PER_MESSAGE).map(resolveImage),
        );
        const kept = resolved.filter((x): x is Img => x !== null);
        msg.images = kept.length > 0 ? kept : undefined;
      }),
    );
  }

  /**
   * Rescue dead local image links in agent prose. Agents link screenshots as
   * `![…](/var/folders/…/shot.jpg)` or `[label](/tmp/shot.png)` — paths the
   * viewer's browser can never read, so the link is dead the moment it syncs.
   * Before a message ships, upload each linked local raster image and rewrite
   * the link to its stable storage URL, which renders inline in the transcript.
   *
   * Assistant messages only: user-message text carries the tmux-injected
   * `/codecast/images/<id>.png` paths that echo reconciliation parses
   * (messages.ts injectedImageStorageIds) — rewriting those would break it.
   * Uploads dedup through the persistent image cache (~/.codecast), and a
   * since-deleted temp file falls back to the last URL uploaded for its path,
   * so re-syncs are stable across daemon restarts.
   */
  async rescueLocalImageLinks(messages: Array<{ role?: string; content?: string }>): Promise<void> {
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.content || !msg.content.includes("](")) continue;
      const scan = new RegExp(LOCAL_IMAGE_LINK_RE.source, "gi");
      const paths = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = scan.exec(msg.content)) !== null && paths.size < MAX_LINK_RESCUES_PER_MESSAGE) {
        paths.add(m[2]);
      }
      if (paths.size === 0) continue;
      const replacements = new Map<string, string>();
      for (const rawPath of paths) {
        const url = await this.resolveLocalImageUrl(rawPath);
        if (url) replacements.set(rawPath, url);
      }
      if (replacements.size === 0) continue;
      msg.content = msg.content.replace(
        new RegExp(LOCAL_IMAGE_LINK_RE.source, "gi"),
        (full, open: string, linkPath: string, close: string) => {
          const url = replacements.get(linkPath);
          return url ? `${open}${url}${close}` : full;
        },
      );
    }
  }

  private async resolveLocalImageUrl(rawPath: string): Promise<string | null> {
    const absPath = rawPath.startsWith("~/") ? nodePath.join(os.homedir(), rawPath.slice(2)) : rawPath;
    let bytes: Buffer;
    try {
      bytes = await readFile(absPath);
    } catch {
      // Temp screenshots get cleaned up; if this exact path uploaded before,
      // its last-known URL still points at the same picture.
      return lookupByPath(absPath)?.url ?? null;
    }
    if (bytes.length > MAX_IMAGE_SIZE) return null;
    const mediaType = detectImageMediaType(bytes);
    if (!mediaType || !RESCUABLE_IMAGE_TYPES.has(mediaType)) return null;
    const hash = hashImageBytes(bytes);
    const cached = lookupByHash(hash);
    if (cached) return cached.url;
    const storageId = await this.uploadImage(bytes.toString("base64"), mediaType);
    if (!storageId) return null;
    const url = await this.getImageUrl(storageId);
    if (!url) return null;
    storeUpload({ hash, absPath, storageId, url });
    return url;
  }

  async uploadImage(base64Data: string, mediaType: string): Promise<string | null> {
    if (!base64Data) {
      console.warn("[SyncService] uploadImage called with no data");
      return null;
    }
    const decoded = decodeImageBase64(base64Data);
    if (!decoded) {
      console.warn("[SyncService] Image upload rejected: unsupported or invalid image payload");
      return null;
    }
    if (!mediaType.startsWith("image/")) {
      console.warn(`[SyncService] Image upload rejected: invalid media type ${mediaType}`);
      return null;
    }
    try {
      const binaryData = decoded.data;
      if (binaryData.length > MAX_IMAGE_SIZE) {
        console.warn(`[SyncService] Image too large: ${binaryData.length} bytes > ${MAX_IMAGE_SIZE}`);
        return null;
      }
      const uploadUrl = await withTimeout(
        this.mutate(
          "images:generateUploadUrl" as any,
          { api_token: this.apiToken }
        ),
        this.imageUploadTimeoutMs,
        "images:generateUploadUrl",
      );
      const response = await withTimeout(
        fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": decoded.mediaType },
          body: new Uint8Array(binaryData),
        }),
        this.imageUploadTimeoutMs,
        "image upload fetch",
      );
      if (!response.ok) {
        console.warn(`[SyncService] Image upload failed: HTTP ${response.status}`);
        return null;
      }
      const result = await response.json();
      return result.storageId;
    } catch (err) {
      console.warn(`[SyncService] Image upload error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async createConversation(params: CreateConversationParams): Promise<string> {
    await this.throttle();
    const projectHash = params.projectPath
      ? hashPath(params.projectPath)
      : undefined;
    const gitInfo = params.gitInfo;
    return this.guarded(async () => {
      const result = await this.mutate(
        "conversations:createConversation" as any,
        {
          user_id: params.userId,
          team_id: params.teamId,
          agent_type: params.agentType,
          session_id: params.sessionId,
          project_hash: projectHash,
          project_path: params.projectPath,
          slug: params.slug,
          title: params.title,
          started_at: params.startedAt,
          parent_message_uuid: params.parentMessageUuid,
          parent_conversation_id: params.parentConversationId,
          git_commit_hash: gitInfo?.commitHash || params.gitCommitHash,
          git_branch: gitInfo?.branch,
          git_remote_url: gitInfo?.remoteUrl,
          git_status: gitInfo?.status,
          git_diff: gitInfo?.diff,
          git_diff_staged: gitInfo?.diffStaged,
          git_root: gitInfo?.repoRoot || gitInfo?.root,
          cli_flags: params.cliFlags,
          worktree_name: gitInfo?.worktreeName,
          worktree_branch: gitInfo?.worktreeBranch,
          worktree_path: gitInfo?.worktreePath,
          worktree_status: gitInfo?.worktreeName ? "active" : undefined,
          subagent_description: params.subagentDescription,
          is_subagent: params.isSubagent || undefined,
          agent_team_name: params.agentTeamName,
          agent_name: params.agentName,
          // The transcript this conversation is created from lives on THIS
          // machine — stamp ownership up front so message delivery routes here
          // instead of racing every daemon's first-claim (a remote daemon that
          // won that race black-holed injects for freshly synced sessions).
          owner_device_id: deviceId(),
          api_token: this.apiToken,
        }
      );
      return result as string;
    });
  }

  async linkSessions(parentConversationId: string, childConversationId: string, subagentDescription?: string): Promise<void> {
    await this.throttle();
    return this.guarded(async () => {
      await this.mutate(
        "conversations:linkSessions" as any,
        {
          parent_conversation_id: parentConversationId,
          child_conversation_id: childConversationId,
          subagent_description: subagentDescription,
          api_token: this.apiToken,
        }
      );
    });
  }

  async killFinishedConversation(conversationId: string): Promise<void> {
    await this.throttle();
    return this.guarded(async () => {
      await this.mutate(
        "conversations:cliSetSessionVisibility" as any,
        {
          session: conversationId,
          action: "kill",
          api_token: this.apiToken,
        }
      );
    });
  }

  // Visible-child link: teammate/spawned session → the session that spawned it.
  // Unlike linkSessions this neither hides the child nor marks it a subagent —
  // it only powers the parent click-through (see conversations.linkSpawnedBy).
  async linkSpawnedBy(
    parentConversationId: string,
    childConversationId: string,
    agentTeamName?: string,
    agentName?: string,
  ): Promise<void> {
    await this.throttle();
    return this.guarded(async () => {
      await this.mutate(
        "conversations:linkSpawnedBy" as any,
        {
          parent_conversation_id: parentConversationId,
          child_conversation_id: childConversationId,
          agent_team_name: agentTeamName,
          agent_name: agentName,
          api_token: this.apiToken,
        }
      );
    });
  }

  async linkPlanHandoff(parentConversationId: string, childConversationId: string): Promise<void> {
    await this.throttle();
    return this.guarded(async () => {
      await this.mutate(
        "conversations:linkPlanHandoff" as any,
        {
          parent_conversation_id: parentConversationId,
          child_conversation_id: childConversationId,
          api_token: this.apiToken,
        }
      );
    });
  }

  async syncPlanFromPlanMode(params: {
    sessionId: string;
    planContent: string;
    projectPath?: string;
  }): Promise<string | null> {
    await this.throttle();
    return this.guarded(async () => {
      const result = await this.mutate(
        "docs:create" as any,
        {
          api_token: this.apiToken,
          title: "",
          content: params.planContent,
          source: "plan_mode",
          conversation_id: params.sessionId,
          project_path: params.projectPath,
        }
      );
      return result?.plan_short_id || null;
    });
  }

  async syncTaskFromPlanMode(params: {
    sessionId: string;
    title: string;
    description?: string;
    planShortId?: string;
  }): Promise<string | null> {
    await this.throttle();
    return this.guarded(async () => {
      const result = await this.mutate(
        "tasks:create" as any,
        {
          api_token: this.apiToken,
          title: params.title,
          description: params.description,
          task_type: "task",
          status: "open",
          priority: "medium",
          source: "plan_mode",
          conversation_id: params.sessionId,
          plan_id: params.planShortId,
        }
      );
      return result?.short_id || null;
    });
  }

  async updateTaskStatus(shortId: string, status: string, sessionId?: string): Promise<void> {
    await this.throttle();
    return this.guarded(async () => {
      await this.mutate(
        "tasks:update" as any,
        {
          api_token: this.apiToken,
          short_id: shortId,
          status,
          conversation_id: sessionId,
        }
      );
    });
  }

  async getPlanSnippet(planShortId: string): Promise<string | null> {
    await this.throttle();
    try {
      return await this.guarded(async () => {
        const result = await this.client.query(
          "plans:snippet" as any,
          {
            api_token: this.apiToken,
            plan_short_id: planShortId,
          }
        );
        return result?.snippet || null;
      });
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      return null;
    }
  }

  async addMessage(params: {
    conversationId: string;
    messageUuid?: string;
    role: "human" | "assistant" | "system";
    content: string;
    timestamp: number;
    thinking?: string;
    toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
    images?: Array<{ mediaType: string; data?: string; localPath?: string; storageId?: string; toolUseId?: string }>;
    subtype?: string;
    model?: string;
  }): Promise<string> {
    await this.throttle();
    await this.rescueLocalImageLinks([params]);
    const imageHolder = [{
      images: params.images ? params.images.map((image) => ({ ...image })) : undefined,
    }];
    await this.offloadImages(imageHolder);
    const redactedContent = truncate(redactSecrets(params.content), MAX_CONTENT_SIZE);
    const redactedThinking = params.thinking
      ? truncate(redactSecrets(params.thinking), MAX_CONTENT_SIZE)
      : undefined;
    const roleMap: Record<string, "user" | "assistant" | "system" | "tool"> = {
      human: "user",
      assistant: "assistant",
      system: "system",
    };

    const toolCalls = params.toolCalls?.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: truncate(redactSecrets(JSON.stringify(tc.input)), MAX_TOOL_RESULT_SIZE),
    }));

    const toolResults = params.toolResults?.map(tr => ({
      tool_use_id: tr.toolUseId,
      content: truncate(redactSecrets(tr.content), MAX_TOOL_RESULT_SIZE),
      is_error: tr.isError,
    }));

    const images: Array<{ media_type: string; storage_id?: string; data?: string; tool_use_id?: string }> = [];
    if (imageHolder[0].images && imageHolder[0].images.length > 0) {
      const imagesToProcess = imageHolder[0].images.slice(0, MAX_IMAGES_PER_MESSAGE);
      for (const img of imagesToProcess) {
        if (img.storageId) {
          images.push({ media_type: img.mediaType, storage_id: img.storageId, tool_use_id: img.toolUseId });
          continue;
        }
        if (!img.data) continue;
        const storageId = await this.uploadImage(img.data, img.mediaType);
        if (storageId) {
          images.push({ media_type: img.mediaType, storage_id: storageId, tool_use_id: img.toolUseId });
        } else {
          const decoded = decodeImageBase64(img.data);
          if (decoded && decoded.data.length <= MAX_INLINE_IMAGE_SIZE) {
            images.push({ media_type: decoded.mediaType, data: img.data, tool_use_id: img.toolUseId });
          }
        }
      }
    }

    return this.guarded(async () => {
      const messageId = await this.mutate(
        "messages:addMessage" as any,
        {
          conversation_id: params.conversationId,
          message_uuid: params.messageUuid,
          role: roleMap[params.role],
          content: redactedContent,
          thinking: redactedThinking,
          tool_calls: toolCalls,
          tool_results: toolResults,
          images: images.length > 0 ? images : undefined,
          subtype: params.subtype,
          model: params.model,
          timestamp: params.timestamp,
          api_token: this.apiToken,
        }
      );
      return messageId as string;
    });
  }

  async addMessages(params: {
    conversationId: string;
    messages: Array<{
      messageUuid?: string;
      role: "human" | "assistant" | "system";
      content: string;
      timestamp: number;
      thinking?: string;
      toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
      images?: Array<{ mediaType: string; data?: string; localPath?: string; storageId?: string; toolUseId?: string }>;
      subtype?: string;
      model?: string;
    }>;
    reconcileRemoteExisting?: boolean;
  }): Promise<{ inserted: number; ids: string[] }> {
    if (params.messages.length === 0) {
      return { inserted: 0, ids: [] };
    }
    await this.rescueLocalImageLinks(params.messages);
    await this.offloadImages(params.messages);

    const roleMap: Record<string, "user" | "assistant" | "system" | "tool"> = {
      human: "user",
      assistant: "assistant",
      system: "system",
    };

    const preparedMessages: Array<any> = [];
    for (const msg of params.messages) {
      const redactedContent = truncate(redactSecrets(msg.content), MAX_CONTENT_SIZE);
      const redactedThinking = msg.thinking
        ? truncate(redactSecrets(msg.thinking), MAX_CONTENT_SIZE)
        : undefined;
      const toolCalls = msg.toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: truncate(redactSecrets(JSON.stringify(tc.input)), MAX_TOOL_RESULT_SIZE),
      }));
      const toolResults = msg.toolResults?.map(tr => ({
        tool_use_id: tr.toolUseId,
        content: truncate(redactSecrets(tr.content), MAX_TOOL_RESULT_SIZE),
        is_error: tr.isError,
      }));

      const images: Array<{ media_type: string; storage_id?: string; data?: string; tool_use_id?: string }> = [];
      if (msg.images && msg.images.length > 0) {
        const imagesToProcess = msg.images.slice(0, MAX_IMAGES_PER_MESSAGE);
        for (const img of imagesToProcess) {
          // Already offloaded (e.g. by offloadImages before enqueue) — pass through.
          if (img.storageId) {
            images.push({ media_type: img.mediaType, storage_id: img.storageId, tool_use_id: img.toolUseId });
            continue;
          }
          if (!img.data) continue;
          const storageId = await this.uploadImage(img.data, img.mediaType);
          if (storageId) {
            images.push({ media_type: img.mediaType, storage_id: storageId, tool_use_id: img.toolUseId });
          } else {
            const decoded = decodeImageBase64(img.data);
            const dataBytes = decoded?.data.length;
            if (decoded && dataBytes !== undefined && dataBytes <= MAX_INLINE_IMAGE_SIZE) {
              images.push({ media_type: decoded.mediaType, data: img.data, tool_use_id: img.toolUseId });
            } else {
              console.warn(
                decoded
                  ? `[SyncService] Image dropped: upload failed and too large for inline (${dataBytes} bytes)`
                  : "[SyncService] Image dropped: unsupported or invalid image payload",
              );
            }
          }
        }
      }

      preparedMessages.push({
        message_uuid: msg.messageUuid,
        role: roleMap[msg.role],
        content: redactedContent,
        thinking: redactedThinking,
        tool_calls: toolCalls,
        tool_results: toolResults,
        images: images.length > 0 ? images : undefined,
        subtype: msg.subtype,
        model: msg.model,
        timestamp: msg.timestamp,
      });
    }

    let sendMessages = preparedMessages;
    if (params.reconcileRemoteExisting) {
      const uuids = sendMessages
        .map((msg) => msg.message_uuid)
        .filter((uuid): uuid is string => typeof uuid === "string" && uuid.length > 0);
      if (uuids.length > 0) {
        const existing = await this.existingMessageUuids(params.conversationId, uuids);
        if (existing && existing.size > 0) {
          sendMessages = sendMessages.filter((msg) => !msg.message_uuid || !existing.has(msg.message_uuid));
          if (sendMessages.length === 0) {
            return { inserted: 0, ids: [] };
          }
        }
      }
    }

    // Batch by bytes, not just count. A single message can carry a large
    // inline image (up to MAX_INLINE_IMAGE_SIZE when Convex storage upload
    // fails), so a count-only cap of BATCH_SIZE lets an image-heavy batch grow
    // to several MB — past what one mutation can commit within
    // ADD_MESSAGES_BATCH_TIMEOUT_MS / the isolate budget. That batch then fails
    // every retry identically, and because sync advances the file position only
    // after a batch lands, the whole tail behind it stays stuck forever. An
    // oversized single message still goes out alone (one message can't split).
    const batches = chunkMessagesBySize(sendMessages);

    // Serialize the actual writes per conversation so concurrent sync triggers
    // don't stampede the one conversation doc (see conversationWriteChains).
    return this.withConversationLock(params.conversationId, async () => {
      let totalInserted = 0;
      const allIds: string[] = [];

      for (const batch of batches) {
        await this.throttle();
        await this.guarded(async () => {
          const result = await withTimeout(
            this.mutate(
              "messages:addMessages" as any,
              {
                conversation_id: params.conversationId,
                messages: batch,
                api_token: this.apiToken,
              }
            ),
            ADD_MESSAGES_BATCH_TIMEOUT_MS,
            `addMessages batch (${batch.length} msgs)`
          );
          const typed = result as { inserted: number; ids: string[] };
          totalInserted += typed.inserted;
          allIds.push(...typed.ids);
        });
      }

      return { inserted: totalInserted, ids: allIds };
    });
  }

  // Delete specific messages by uuid — the daemon's pi branch-switch cleanup removes
  // the abandoned branch's already-synced turns so the conversation equals the active
  // branch exactly. Chunked to the server's per-call cap and serialized behind the
  // conversation's write lock (same discipline as addMessages) so it can't race a
  // concurrent add. Returns how many rows were actually removed.
  async deleteMessagesByUuid(conversationId: string, messageUuids: string[]): Promise<number> {
    if (messageUuids.length === 0) return 0;
    return this.withConversationLock(conversationId, async () => {
      let deleted = 0;
      for (let i = 0; i < messageUuids.length; i += ADD_MESSAGES_BATCH_SIZE) {
        const chunk = messageUuids.slice(i, i + ADD_MESSAGES_BATCH_SIZE);
        await this.throttle();
        await this.guarded(async () => {
          const result = await this.mutate("messages:deleteMessagesByUuid" as any, {
            conversation_id: conversationId,
            message_uuids: chunk,
            api_token: this.apiToken,
          });
          deleted += (result as { deleted: number }).deleted;
        });
      }
      return deleted;
    });
  }

  // Runs `fn` after any in-flight addMessages for the same conversation settles,
  // so writes to one conversation doc never overlap (the OCC-stampede fix above).
  // Each call chains onto the previous one's settled tail; errors are isolated so
  // one failed write can't reject the next queued write. Map entries self-GC when a
  // conversation's chain drains. Distinct conversations never share a chain.
  private withConversationLock<T>(convId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.conversationWriteChains.get(convId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    this.conversationWriteChains.set(convId, tail);
    tail.then(() => {
      if (this.conversationWriteChains.get(convId) === tail) {
        this.conversationWriteChains.delete(convId);
      }
    });
    return run;
  }

  async updateSyncCursor(params: {
    filePath: string;
    byteOffset: number;
  }): Promise<void> {
    if (!this.userId) {
      throw new Error("userId required for sync cursor operations");
    }
    const filePathHash = hashPath(params.filePath);
    return this.guarded(async () => {
      await this.mutate("syncCursors:updateSyncCursor" as any, {
        user_id: this.userId,
        file_path_hash: filePathHash,
        last_position: params.byteOffset,
        api_token: this.apiToken,
      });
    });
  }

  async getSyncCursor(filePath: string): Promise<number> {
    if (!this.userId) {
      throw new Error("userId required for sync cursor operations");
    }
    const filePathHash = hashPath(filePath);
    return this.guarded(async () => {
      const position = await this.client.query(
        "syncCursors:getSyncCursor" as any,
        {
          user_id: this.userId,
          file_path_hash: filePathHash,
          api_token: this.apiToken,
        }
      );
      return position ?? 0;
    });
  }

  async updateTitle(conversationId: string, title: string): Promise<void> {
    return this.guarded(async () => {
      await this.mutate("conversations:updateTitle" as any, {
        conversation_id: conversationId,
        title,
        api_token: this.apiToken,
      });
    });
  }

  async setAvailableSkills(conversationId: string | undefined, skills: string, projectPath?: string): Promise<void> {
    try {
      await this.mutate("conversations:setAvailableSkills" as any, {
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(projectPath ? { project_path: projectPath } : {}),
        skills,
        api_token: this.apiToken,
      });
    } catch {}
  }

  async updateProjectPath(sessionId: string, projectPath: string, gitRoot?: string): Promise<{ updated: boolean } | null> {
    try {
      const result = await this.mutate("conversations:updateProjectPath" as any, {
        session_id: sessionId,
        project_path: projectPath,
        git_root: gitRoot,
        api_token: this.apiToken,
      });
      return result as { updated: boolean } | null;
    } catch {
      return null;
    }
  }

  // Throws on failure — callers must handle it. This is the one write that
  // keeps a conversation answering to its live session uuid; a bare catch here
  // silently stranded conversations on their spawn-time stub id, so every
  // session-bound `cast` write from the agent failed "Conversation not found"
  // while message sync (keyed by conversation _id) looked perfectly healthy.
  async updateSessionId(conversationId: string, sessionId: string, projectPath?: string, gitRoot?: string): Promise<void> {
    await this.mutate("conversations:updateSessionId" as any, {
      conversation_id: conversationId,
      session_id: sessionId,
      project_path: projectPath,
      git_root: gitRoot,
      api_token: this.apiToken,
    });
  }

  /** Owner device of a conversation (single-owner guard). null if unknown/unowned. */
  // The session's inbox filing ("stashed" | "killed" | null), read just before
  // a trigger injection so the wake-time preamble can tell the agent whether
  // anyone is watching (taskScheduler). Rides the thread-state read — same
  // access rule, one round trip. Fails open: no answer = say nothing.
  async getSessionFiling(conversationId: string): Promise<"stashed" | "killed" | null> {
    try {
      const res: any = await this.client.query("conversations:getThreadState" as any, {
        session: conversationId,
        api_token: this.apiToken,
      });
      return res?.visibility ?? null;
    } catch {
      return null;
    }
  }

  async getConversationOwner(conversationId: string): Promise<string | null> {
    return (await this.getConversationOwnerInfo(conversationId))?.ownerDeviceId ?? null;
  }

  /**
   * Owner device of a conversation, with whether that owner is a remote box and
   * online. Lets a local daemon distinguish "another laptop owns this, back off"
   * from "a remote owns this but can only serve an explicitly-moved session — if I
   * have the checkout I should reclaim it." null if unknown/unowned.
   */
  async getConversationOwnerInfo(
    conversationId: string,
  ): Promise<{ ownerDeviceId: string; ownerIsRemote: boolean; ownerOnline: boolean } | null> {
    try {
      const res = await this.client.query("devices:getConversationOwner" as any, {
        api_token: this.apiToken,
        conversation_id: conversationId,
      });
      const ownerDeviceId = res && (res as any).owner_device_id;
      if (!ownerDeviceId) return null;
      return {
        ownerDeviceId,
        ownerIsRemote: !!(res as any).owner_is_remote,
        ownerOnline: !!(res as any).owner_online,
      };
    } catch {
      return null;
    }
  }

  /**
   * Lifecycle + inbox-visibility state of a conversation — the daemon's gate for
   * "may I bring this session back?" and "may I reap its pane?". A killed or
   * hidden conversation is exactly the one no automation may resurrect.
   *
   * Three routes, best first — see the body for why each exists:
   *   A. conversations:getConversationLifecycle by conversation_id (exact row)
   *   B. the same query by session_id (NEWEST twin) when the id is a ghost
   *   C. devices:resolveConversationBySession — status only, OLDEST twin — only
   *      when the query itself is unavailable (undeployed backend / transient
   *      error), never when it answered "no such conversation"
   * A and B return `hideStateKnown: true`; C is marked degraded so callers can
   * refuse to act on it. Returns null when nothing resolves, which callers read
   * as "unknown" and handle per their own fail-open/fail-closed policy.
   */
  async getConversationLifecycle(
    conversationId: string,
    sessionId?: string,
  ): Promise<ConversationLifecycle | null> {
    if (shouldProbeLifecycleQuery(lifecycleQueryMissingSince, Date.now())) {
      try {
        // The query takes EXACTLY ONE selector (it returns null when both or
        // neither are set), so the two routes are separate calls.
        //
        // Route A — the conversation id, an exact ctx.db.get. Always tried first:
        // when the row exists this is unambiguous, with no twin reduction at all.
        let res: any = await this.client.query("conversations:getConversationLifecycle" as any, {
          api_token: this.apiToken,
          conversation_id: conversationId,
        });
        // Route B — the GHOST case, which is the whole reason a fallback exists:
        // the id we were handed no longer resolves (deleted/remapped row, a
        // client's cached copy), but the session is alive under a twin. The
        // query's session route picks the NEWEST twin by updated_at, so it beats
        // devices:resolveConversationBySession on both counts — right row, and
        // full hide state instead of status only.
        if (!res && sessionId) {
          res = await this.client.query("conversations:getConversationLifecycle" as any, {
            api_token: this.apiToken,
            session_id: sessionId,
          });
        }
        lifecycleQueryMissingSince = 0; // the probe answered — clear any stale latch
        if (res) {
          return {
            status: res.status ?? null,
            inboxKilledAt: res.inbox_killed_at ?? null,
            inboxStashedAt: res.inbox_stashed_at ?? null,
            inboxDismissedAt: res.inbox_dismissed_at ?? null,
            inboxPinnedAt: res.inbox_pinned_at ?? null,
            hideStateKnown: true,
            source: "lifecycle",
          };
        }
        // Both routes reached the query and it found nothing. That is an answer,
        // not an outage — and the devices fallback reads the same by_session_id
        // index under the same user filter, so it cannot do better. Don't paper
        // over a real "no such conversation" with a second miss.
        return null;
      } catch (err) {
        // ONLY an undeployed function latches. Anything else (network, 5xx,
        // timeout) is transient: leave the latch alone and let the caller's own
        // fail-open/fail-closed policy handle this one call.
        if (isMissingFunctionError(err)) lifecycleQueryMissingSince = Date.now();
      }
    }
    // Legacy-backend path only — reached when the query above is undeployed or
    // errored, never when it simply found nothing. Status only, resolved by
    // session id through `.first()` (the OLDEST twin), so it is marked degraded
    // and most callers refuse to act on it.
    if (!sessionId) return null;
    try {
      const res: any = await this.client.query("devices:resolveConversationBySession" as any, {
        api_token: this.apiToken,
        session_id: sessionId,
      });
      return res ? { status: res.status ?? null, hideStateKnown: false, source: "status-fallback" } : null;
    } catch {
      return null;
    }
  }

  async registerManagedSession(sessionId: string, pid: number, tmuxSession?: string, conversationId?: string): Promise<{ notOwner?: boolean; owner?: string } | void> {
    try {
      const res = await this.mutate("managedSessions:registerManagedSession" as any, {
        session_id: sessionId,
        pid,
        tmux_session: tmuxSession,
        conversation_id: conversationId,
        api_token: this.apiToken,
        device_id: deviceId(),
      });
      // Single-owner invariant: another live device owns this session → caller backs off.
      if (res && typeof res === "object" && (res as any).notOwner) {
        return { notOwner: true, owner: (res as any).owner };
      }
    } catch {}
  }

  async heartbeatManagedSession(
    sessionId: string,
    agentStatus?: AgentStatus,
  ): Promise<{ found: boolean; dismissed?: boolean } | undefined> {
    try {
      return await this.mutate("managedSessions:heartbeat" as any, {
        session_id: sessionId,
        api_token: this.apiToken,
        ...(agentStatus ? { agent_status: agentStatus, client_ts: Date.now() } : {}),
      });
    } catch {}
  }

  // Liveness heartbeat for many sessions in one transaction — see
  // managedSessions:heartbeatBatch. The daemon flushes the whole fleet through
  // this on a single timer instead of one mutation per session, so the inbox
  // subscription is invalidated once per flush rather than once per session.
  async heartbeatManagedSessionsBatch(
    sessions: Array<{
      session_id: string;
      agent_status?: AgentStatus;
      client_ts?: number;
    }>,
  ): Promise<{ updated: number } | undefined> {
    if (sessions.length === 0) return;
    try {
      return await this.mutate("managedSessions:heartbeatBatch" as any, {
        api_token: this.apiToken,
        sessions,
      });
    } catch {}
  }

  async reportSessionMetrics(sessionId: string, cpu: number, memory: number, pidCount: number, agentPid?: number, awakeIdleMs?: number, agentStartedAt?: number): Promise<void> {
    try {
      await this.mutate("managedSessions:reportMetrics" as any, {
        session_id: sessionId,
        cpu,
        memory,
        pid_count: pidCount,
        ...(agentPid !== undefined ? { agent_pid: agentPid } : {}),
        ...(awakeIdleMs !== undefined ? { awake_idle_ms: awakeIdleMs } : {}),
        ...(agentStartedAt !== undefined ? { agent_started_at: agentStartedAt } : {}),
        api_token: this.apiToken,
      });
    } catch {}
  }

  async findLocalCheckouts(gitRemoteUrl: string): Promise<string[]> {
    if (!gitRemoteUrl) return [];
    try {
      return await this.guarded(async () => {
        const result = await this.client.query("conversations:findUserLocalCheckouts" as any, {
          git_remote_url: gitRemoteUrl,
          api_token: this.apiToken,
        });
        if (!Array.isArray(result)) return [];
        return result.map((r: any) => r?.git_root).filter((g: any): g is string => typeof g === "string" && g.length > 0);
      });
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      return [];
    }
  }

  async getProjectInfo(conversationId: string): Promise<{ project_path: string | null; git_root: string | null; git_remote_url: string | null; effort: string | null; cc_account: string | null; execution_protocol_state: string | null } | null> {
    try {
      return await this.guarded(async () => {
        const result = await this.client.query("conversations:getProjectInfo" as any, {
          conversation_id: conversationId,
          api_token: this.apiToken,
        });
        if (!result) return null;
        return {
          project_path: result.project_path ?? null,
          git_root: result.git_root ?? null,
          git_remote_url: result.git_remote_url ?? null,
          effort: result.effort ?? null,
          cc_account: result.cc_account ?? null,
          execution_protocol_state: result.execution_protocol_state ?? null,
        };
      });
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      return null;
    }
  }

  async ackInjectedMessages(
    conversationId: string,
    pastedMessageIds?: string[],
    deliveryAcks?: Array<{
      pendingMessageId: string;
      transcriptMessageId: string;
    }>,
  ): Promise<void> {
    try {
      await this.guarded(() =>
        this.mutate("pendingMessages:ackInjectedMessages" as any, {
          conversation_id: conversationId,
          api_token: this.apiToken,
          device_id: deviceId(),
          ...(pastedMessageIds ? { message_ids: pastedMessageIds } : {}),
          ...(deliveryAcks?.length
            ? {
                delivery_acks: deliveryAcks.map((ack) => ({
                  pending_message_id: ack.pendingMessageId,
                  transcript_message_id: ack.transcriptMessageId,
                })),
              }
            : {}),
        })
      );
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      // Non-critical — don't let ack failures break the sync loop
    }
  }

  async resetInjectedMessages(conversationId: string): Promise<void> {
    try {
      await this.guarded(() =>
        this.mutate("pendingMessages:resetInjectedMessages" as any, {
          conversation_id: conversationId,
          api_token: this.apiToken,
          device_id: deviceId(),
        })
      );
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
    }
  }

  async updateMessageStatus(params: {
    messageId: string;
    status: "pending" | "injected" | "delivered" | "failed" | "undeliverable";
    deliveredAt?: number;
  }): Promise<void> {
    return this.guarded(async () => {
      await this.mutate("pendingMessages:updateMessageStatus" as any, {
        message_id: params.messageId,
        status: params.status,
        delivered_at: params.deliveredAt,
        api_token: this.apiToken,
        device_id: deviceId(),
      });
    });
  }

  // Terminal: "cancelled" is the one status the server's stuck-message cron
  // never re-pends. For a message that no delivery path can ever land.
  async cancelPendingMessage(messageId: string): Promise<void> {
    return this.guarded(async () => {
      await this.mutate("pendingMessages:cancelPendingMessage" as any, {
        message_id: messageId,
        api_token: this.apiToken,
      });
    });
  }

  async retryMessage(messageId: string): Promise<void> {
    return this.guarded(async () => {
      await this.mutate("pendingMessages:retryMessage" as any, {
        message_id: messageId,
        api_token: this.apiToken,
        device_id: deviceId(),
      });
    });
  }

  async claimPendingMessageForDelivery(messageId: string): Promise<PendingMessageForDelivery | null> {
    return this.guarded(async () => {
      const result = await this.mutate("pendingMessages:claimPendingMessageForDelivery" as any, {
        message_id: messageId,
        api_token: this.apiToken,
        device_id: deviceId(),
      });
      return (result ?? null) as PendingMessageForDelivery | null;
    });
  }

  // `origin: "scheduler"` marks a machine-initiated injection (task scheduler):
  // the server then leaves a HIDDEN stash (`cast stash --hide`) in place so a
  // looping session keeps working out of the user's active queue; a plain
  // stash pops back into the inbox on the wake. Human/agent sends omit it.
  async sendMessageToSession(conversationId: string, content: string, origin?: "scheduler"): Promise<string | null> {
    if (!this.apiToken) return null;
    return this.guarded(async () => {
      const result = await this.mutate(
        "pendingMessages:sendMessageToSession" as any,
        {
          conversation_id: conversationId,
          content,
          ...(origin ? { origin } : {}),
          api_token: this.apiToken,
        },
      );
      return result as string;
    });
  }


  async setSessionError(conversationId: string, error?: string): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.mutate(
        "conversations:setSessionError" as any,
        {
          conversation_id: conversationId,
          error,
          api_token: this.apiToken,
        }
      );
    } catch {}
  }

  /**
   * Claim a conversation for this device on a successful start: stamps
   * owner_device_id and clears any stale session_error (e.g. a "clone it first"
   * refusal another device wrote when it lacked the checkout).
   */
  async claimSession(conversationId: string): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.mutate(
        "devices:claimConversation" as any,
        {
          conversation_id: conversationId,
          device_id: deviceId(),
          api_token: this.apiToken,
        }
      );
    } catch {}
  }

  /** The per-session account a RESUME must source, resolved by the server
   * (accountSwitch.pinForResume): the row's pin, unless the session is
   * parked on a limit/auth banner under a pin this device would not
   * continue on — then the server rewrites the row and answers with the
   * corrected pin. Falls back to the raw row read when the call fails, so an
   * old server or a blip never blocks a resume. */
  async pinForResume(conversationId: string): Promise<{ cc_account: string | null } | null> {
    if (!this.apiToken) return null;
    try {
      const res = await this.mutate("accountSwitch:pinForResume" as any, {
        conversation_id: conversationId,
        device_id: deviceId(),
        api_token: this.apiToken,
      });
      return res && typeof res === "object" ? { cc_account: (res as any).cc_account ?? null } : null;
    } catch {
      return null;
    }
  }

  /**
   * Atomic pre-spawn ownership claim. Returns { won: false } if another LIVE
   * device already owns this conversation, so the caller skips spawning — the
   * tie-break that stops two daemons both starting a broadcast start_session.
   * Fail-open: on any transient error we return won:true rather than block.
   */
  async claimConversationForStart(conversationId: string): Promise<{ won: boolean; owner?: string }> {
    if (!this.apiToken) return { won: true };
    try {
      const res = await this.mutate(
        "devices:claimConversationForStart" as any,
        {
          conversation_id: conversationId,
          device_id: deviceId(),
          api_token: this.apiToken,
        }
      );
      return (res as { won: boolean; owner?: string }) ?? { won: true };
    } catch {
      return { won: true };
    }
  }

  async markSessionCompleted(conversationId: string): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.mutate(
        "conversations:markSessionCompleted" as any,
        {
          conversation_id: conversationId,
          api_token: this.apiToken,
        }
      );
    } catch {}
  }

  async markSessionActive(conversationId: string): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.mutate(
        "conversations:markSessionActive" as any,
        {
          conversation_id: conversationId,
          api_token: this.apiToken,
        }
      );
    } catch {}
  }

  async updateSessionAgentStatus(conversationId: string, status: AgentStatus, clientTs?: number, permissionMode?: string, openTasks?: OpenTaskReport[]): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.mutate(
        "managedSessions:updateAgentStatus" as any,
        {
          conversation_id: conversationId,
          agent_status: status,
          client_ts: clientTs || Date.now(),
          api_token: this.apiToken,
          ...(permissionMode ? { permission_mode: permissionMode } : {}),
          ...(openTasks ? { open_tasks: openTasks } : {}),
        }
      );
    } catch {}
  }

  async listManagedSessions(): Promise<Array<{
    session_id: string;
    conversation_id?: string;
    tmux_session?: string;
    agent_pid?: number;
    last_metrics_at?: number;
  }> | null> {
    try {
      return await this.client.query("managedSessions:listManagedSessionsForDaemon" as any, {
        api_token: this.apiToken,
      });
    } catch {
      return null;
    }
  }

  async checkManagedSession(conversationId: string): Promise<{ managed: boolean; session_id?: string; pid?: number } | null> {
    try {
      const result = await this.client.query("managedSessions:isSessionManaged" as any, {
        conversation_id: conversationId,
        api_token: this.apiToken,
      });
      return result;
    } catch {
      return null;
    }
  }

  async createPermissionRequest(params: {
    conversation_id: string;
    session_id: string;
    tool_name: string;
    arguments_preview: string;
  }): Promise<string> {
    return this.guarded(async () => {
      const permissionId = await this.mutate(
        "permissions:createPermissionRequest" as any,
        {
          conversation_id: params.conversation_id,
          session_id: params.session_id,
          tool_name: params.tool_name,
          arguments_preview: params.arguments_preview,
          api_token: this.apiToken,
        }
      );
      return permissionId as string;
    });
  }

  async cancelPermissionRequest(permissionId: string): Promise<boolean> {
    return this.guarded(async () => {
      const ok = await this.mutate(
        "permissions:cancelPermissionRequest" as any,
        {
          permission_id: permissionId,
          api_token: this.apiToken,
        }
      );
      return Boolean(ok);
    });
  }

  async cancelPendingPermissions(sessionId: string, createdBefore?: number): Promise<number> {
    return this.guarded(async () => {
      const cancelled = await this.mutate(
        "permissions:cancelPendingPermissions" as any,
        {
          session_id: sessionId,
          ...(createdBefore !== undefined && { created_before: createdBefore }),
          api_token: this.apiToken,
        }
      );
      return Number(cancelled) || 0;
    });
  }

  async getPermissionDecision(sessionId: string, permissionId?: string): Promise<{
    _id: string;
    status: "approved" | "denied" | "cancelled";
    resolved_at?: number;
    tool_name: string;
  } | null> {
    return this.guarded(async () => {
      const decision = await this.client.query(
        "permissions:getPermissionDecision" as any,
        {
          session_id: sessionId,
          ...(permissionId ? { permission_id: permissionId } : {}),
          api_token: this.apiToken,
        }
      );
      return decision as any;
    });
  }

  async getMinCliVersion(): Promise<string | null> {
    try {
      const version = await this.client.query(
        "systemConfig:getMinCliVersion" as any,
        {}
      );
      return version as string | null;
    } catch {
      return null;
    }
  }

  async getMinDesktopVersion(): Promise<string | null> {
    try {
      const version = await this.client.query(
        "systemConfig:getMinDesktopVersion" as any,
        {}
      );
      return version as string | null;
    } catch {
      return null;
    }
  }

  async syncLogs(logs: Array<{
    level: "debug" | "info" | "warn" | "error";
    message: string;
    metadata?: {
      session_id?: string;
      error_code?: string;
      stack?: string;
    };
    daemon_version?: string;
    platform?: string;
    timestamp: number;
  }>): Promise<{ inserted: number } | null> {
    if (!this.apiToken || logs.length === 0) {
      return null;
    }
    try {
      const result = await this.mutate(
        "daemonLogs:insertBatch" as any,
        {
          api_token: this.apiToken,
          logs,
        }
      );
      return result as { inserted: number };
    } catch {
      return null;
    }
  }

  async createSessionNotification(params: {
    conversation_id: string;
    type: "session_idle" | "permission_request" | "session_error";
    title: string;
    message: string;
  }): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.mutate(
        "notifications:createSessionNotification" as any,
        {
          api_token: this.apiToken,
          conversation_id: params.conversation_id,
          type: params.type,
          title: params.title,
          message: params.message,
        }
      );
    } catch {
      // Best-effort notification
    }
  }

  async getMessageCountsForReconciliation(
    sessionIds: string[],
    conversationIdHints: Array<{ session_id: string; conversation_id: string }> = []
  ): Promise<Array<{
    session_id: string;
    conversation_id: string;
    message_count: number;
    updated_at: number;
  }>> {
    if (!this.apiToken || sessionIds.length === 0) {
      return [];
    }
    return this.guarded(async () => {
      const result = await this.client.query(
        "conversations:getMessageCountsForReconciliation" as any,
        {
          session_ids: sessionIds,
          conversation_id_hints: conversationIdHints.length > 0 ? conversationIdHints : undefined,
          api_token: this.apiToken,
        }
      );
      return result as Array<{
        session_id: string;
        conversation_id: string;
        message_count: number;
        updated_at: number;
      }>;
    });
  }

  // --- Agent Tasks ---

  async getDueTasks(limit?: number): Promise<any[]> {
    if (!this.apiToken) return [];
    try {
      const result = await this.client.query(
        "agentTasks:getDueTasks" as any,
        { api_token: this.apiToken, limit }
      );
      return (result as any[]) || [];
    } catch {
      return [];
    }
  }

  async claimTask(taskId: string, daemonId: string): Promise<any> {
    if (!this.apiToken) return null;
    try {
      return await this.mutate(
        "agentTasks:claimTask" as any,
        { api_token: this.apiToken, task_id: taskId, daemon_id: daemonId }
      );
    } catch {
      return null;
    }
  }

  async renewTaskLease(taskId: string, daemonId: string): Promise<boolean> {
    if (!this.apiToken) return false;
    try {
      const result = await this.mutate(
        "agentTasks:renewLease" as any,
        { api_token: this.apiToken, task_id: taskId, daemon_id: daemonId }
      );
      return result as boolean;
    } catch {
      return false;
    }
  }

  async completeTaskRun(taskId: string, daemonId: string, summary?: string, conversationId?: string, runSessionUuid?: string): Promise<boolean> {
    if (!this.apiToken) return false;
    try {
      const result = await this.mutate(
        "agentTasks:completeTaskRun" as any,
        {
          api_token: this.apiToken,
          task_id: taskId,
          daemon_id: daemonId,
          summary,
          conversation_id: conversationId,
          run_session_uuid: runSessionUuid,
        }
      );
      return result as boolean;
    } catch {
      return false;
    }
  }

  async failTaskRun(taskId: string, daemonId: string, error?: string, runSessionUuid?: string): Promise<boolean> {
    if (!this.apiToken) return false;
    try {
      const result = await this.mutate(
        "agentTasks:failTaskRun" as any,
        { api_token: this.apiToken, task_id: taskId, daemon_id: daemonId, error, run_session_uuid: runSessionUuid }
      );
      return result as boolean;
    } catch {
      return false;
    }
  }

  // Stamp agent_task_id on a spawned run's conversation (and fold the previous
  // completed run of a repeating spawn schedule). { retry: true } means the
  // run's conversation hasn't synced yet — call again shortly.
  async linkRunConversation(taskId: string, runSessionUuid: string): Promise<{ linked: boolean; retry: boolean }> {
    if (!this.apiToken) return { linked: false, retry: false };
    try {
      const result = await this.mutate(
        "agentTasks:linkRunConversation" as any,
        { api_token: this.apiToken, task_id: taskId, run_session_uuid: runSessionUuid }
      );
      return result as { linked: boolean; retry: boolean };
    } catch {
      // Unknown mutation (older deployed backend) or transient failure — the
      // completeTaskRun backfill still stamps the link at run end.
      return { linked: false, retry: false };
    }
  }
}
