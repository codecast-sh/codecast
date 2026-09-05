export type CloudWakeHost = {
  ownerUserId: string;
  deviceId: string;
  instanceId: string;
  region: string;
};

export type AwsWakeCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export class CloudWakeAwsError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(status === undefined ? code : `${code} (HTTP ${status})`);
    this.name = "CloudWakeAwsError";
  }
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTANCE_ID = /^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
const REGION = /^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|north|northeast|northwest|south|southeast|southwest|east|west)-[1-9][0-9]?$/;
const HOST_KEYS = ["ownerUserId", "deviceId", "instanceId", "region"] as const;
const XML_NAMESPACE = "http://ec2.amazonaws.com/doc/2016-11-15/";
const MAX_XML_LENGTH = 65_536;
const AWS_ERROR_CODES = new Set([
  "AuthFailure", "UnauthorizedOperation", "DryRunOperation", "InvalidClientTokenId",
  "ExpiredToken", "ExpiredTokenException", "RequestExpired", "SignatureDoesNotMatch",
  "IncompleteSignature", "InvalidSignatureException", "MissingAuthenticationToken",
  "InvalidInstanceID.Malformed", "InvalidInstanceID.NotFound", "IncorrectInstanceState",
  "IncorrectState", "UnsupportedOperation", "OperationNotPermitted", "InvalidParameterValue",
  "InvalidParameterCombination", "MissingParameter", "OptInRequired", "PendingVerification",
  "Blocked", "AccountDisabled", "InsufficientInstanceCapacity", "InsufficientHostCapacity",
  "InsufficientCapacity", "RequestLimitExceeded", "Throttling", "ThrottlingException",
  "InternalError", "InternalFailure", "ServerInternal", "ServiceUnavailable", "Unavailable",
  "RequestTimeout", "RequestTimeoutException", "Unsupported", "UnsupportedHostConfiguration",
]);

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value.trim() === value && pattern.test(value);
}

function isHost(value: unknown): value is CloudWakeHost {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === HOST_KEYS.length
    && matches(row.ownerUserId, OPAQUE_ID)
    && matches(row.deviceId, OPAQUE_ID)
    && matches(row.instanceId, INSTANCE_ID)
    && matches(row.region, REGION);
}

export function parseCloudWakeAllowlist(raw: string | undefined): CloudWakeHost[] {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) return [];
  if (typeof raw !== "string" || raw.length > 65_536) throw new CloudWakeAwsError("InvalidAllowlist");
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    throw new CloudWakeAwsError("InvalidAllowlist");
  }
  if (!Array.isArray(rows) || rows.length > 32) throw new CloudWakeAwsError("InvalidAllowlist");
  const devices = new Set<string>();
  const instanceOwners = new Map<string, string>();
  return rows.map((row) => {
    if (!isHost(row)) throw new CloudWakeAwsError("InvalidAllowlist");
    const device = `${row.ownerUserId}\0${row.deviceId}`;
    const owner = instanceOwners.get(row.instanceId);
    if (devices.has(device) || (owner !== undefined && owner !== row.ownerUserId)) {
      throw new CloudWakeAwsError("InvalidAllowlist");
    }
    devices.add(device);
    instanceOwners.set(row.instanceId, row.ownerUserId);
    return row;
  });
}

export function findCloudWakeHost(hosts: CloudWakeHost[], ownerUserId: string, deviceId: string): CloudWakeHost | undefined {
  return hosts.find((host) => host.ownerUserId === ownerUserId && host.deviceId === deviceId);
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

async function hmac(key: ArrayBuffer, value: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
}

export async function buildStartInstancesRequest(
  host: CloudWakeHost,
  credentials: AwsWakeCredentials,
  { now = new Date(), dryRun = false }: { now?: Date; dryRun?: boolean } = {},
): Promise<{ url: string; method: "POST"; headers: Record<string, string>; body: string }> {
  const target = { ...host };
  const { accessKeyId, secretAccessKey, sessionToken } = credentials ?? {};
  if (!isHost(target)) throw new CloudWakeAwsError("InvalidHost");
  if (!matches(accessKeyId, /^[A-Za-z0-9]{1,128}$/)
    || !matches(secretAccessKey, /^[A-Za-z0-9/+=]{1,512}$/)
    || (sessionToken !== undefined && !matches(sessionToken, /^[A-Za-z0-9/+=]{1,8192}$/))) {
    throw new CloudWakeAwsError("InvalidCredentials");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getUTCFullYear() < 1970
    || now.getUTCFullYear() > 9999 || typeof dryRun !== "boolean") throw new CloudWakeAwsError("InvalidRequest");
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const hostname = `ec2.${target.region}.amazonaws.com`;
  const body = new URLSearchParams({ Action: "StartInstances", Version: "2016-11-15", "InstanceId.1": target.instanceId });
  if (dryRun) body.set("DryRun", "true");
  const payload = body.toString();
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    host: hostname,
    "x-amz-date": timestamp,
  };
  if (sessionToken !== undefined) headers["x-amz-security-token"] = sessionToken;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const scope = `${date}/${target.region}/ec2/aws4_request`;
  try {
    const canonical = ["POST", "/", "", canonicalHeaders, signedHeaders, await sha256(payload)].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", timestamp, scope, await sha256(canonical)].join("\n");
    const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`).buffer, date);
    const regionKey = await hmac(dateKey, target.region);
    const serviceKey = await hmac(regionKey, "ec2");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const signature = hex(await hmac(signingKey, toSign));
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  } catch {
    throw new CloudWakeAwsError("SigningFailed");
  }
  return { url: `https://${hostname}/`, method: "POST", headers, body: payload };
}

type XmlNode = { name: string; text: string; children: XmlNode[] };

function parseResponseXml(xml: string, status: number): XmlNode {
  const invalid = () => new CloudWakeAwsError("InvalidResponse", status);
  if (xml.length > MAX_XML_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)) throw invalid();
  const source = xml.trim().replace(/^<\?xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])[Uu][Tt][Ff]-8\2)?(?:\s+standalone=(["'])(?:yes|no)\3)?\s*\?>/, "");
  const tokens = /<[^>]*>|[^<]+/gy;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let offset = 0;
  let count = 0;
  for (const match of source.matchAll(tokens)) {
    if (match.index !== offset || ++count > 512) throw invalid();
    const token = match[0];
    offset += token.length;
    const parent = stack[stack.length - 1];
    if (!token.startsWith("<")) {
      if ((!parent && token.trim()) || /&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)|\]\]>/.test(token)) throw invalid();
      for (const entity of token.matchAll(/&#(x[0-9A-Fa-f]+|[0-9]+);/g)) {
        const code = entity[1].startsWith("x") ? Number.parseInt(entity[1].slice(1), 16) : Number(entity[1]);
        if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
          || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) throw invalid();
      }
      if (parent) parent.text += token;
    } else if (token.startsWith("</")) {
      const closing = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(token);
      if (!closing || parent?.name !== closing[1]) throw invalid();
      stack.pop();
    } else {
      const opening = /^<([A-Za-z][A-Za-z0-9]*)(?:\s+xmlns=(["'])([^"']*)\2)?\s*(\/?)>$/.exec(token);
      if (!opening || (opening[3] !== undefined && (parent || opening[3] !== XML_NAMESPACE)) || stack.length >= 8) throw invalid();
      const node: XmlNode = { name: opening[1], text: "", children: [] };
      if (parent) parent.children.push(node);
      else if (root) throw invalid();
      else root = node;
      if (!opening[4]) stack.push(node);
    }
  }
  if (!root || stack.length || offset !== source.length) throw invalid();
  return root;
}

function childrenOnly(node: XmlNode, names: string[]): boolean {
  return !node.text.trim() && node.children.every((child) => names.includes(child.name))
    && new Set(node.children.map((child) => child.name)).size === node.children.length;
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  const matches = node?.children.filter((entry) => entry.name === name);
  return matches?.length === 1 ? matches[0] : undefined;
}

function value(node: XmlNode | undefined): string | undefined {
  return node && node.children.length === 0 ? node.text.trim() : undefined;
}

function requestId(root: XmlNode, name: string, status: number): { requestId?: string } {
  const id = child(root, name);
  if (!id) return {};
  const text = value(id);
  if (!text || !/^[A-Za-z0-9-]{1,128}$/.test(text)) throw new CloudWakeAwsError("InvalidResponse", status);
  return { requestId: text };
}

export async function startCloudInstance(
  host: CloudWakeHost,
  credentials: AwsWakeCredentials,
  opts: { fetchImpl?: typeof fetch; now?: Date; dryRun?: boolean } = {},
): Promise<{ status: "starting" | "dry_run_allowed"; requestId?: string }> {
  const target = { ...host };
  const { fetchImpl = fetch, now, dryRun = false } = opts;
  const request = await buildStartInstancesRequest(target, credentials, { now, dryRun });
  const signal = AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "manual", signal });
  } catch {
    throw new CloudWakeAwsError(signal.aborted ? "RequestTimeout" : "NetworkError");
  }
  const status = response.status;
  if (response.redirected || (status >= 300 && status < 400)) throw new CloudWakeAwsError("RedirectRejected", status);
  let xml: string;
  try {
    xml = await response.text();
  } catch {
    throw new CloudWakeAwsError(signal.aborted ? "RequestTimeout" : "NetworkError", status);
  }
  const root = parseResponseXml(xml, status);
  if (status >= 400 && status <= 599) {
    const errors = child(root, "Errors");
    const error = child(errors, "Error");
    const code = value(child(error, "Code"));
    if (root.name !== "Response" || !childrenOnly(root, ["Errors", "RequestID"])
      || !errors || !childrenOnly(errors, ["Error"]) || !error || !childrenOnly(error, ["Code", "Message"])
      || !code || !/^[A-Za-z][A-Za-z0-9.]{0,95}$/.test(code)) throw new CloudWakeAwsError("InvalidResponse", status);
    if (code === "DryRunOperation" && dryRun && status === 412) {
      return { status: "dry_run_allowed", ...requestId(root, "RequestID", status) };
    }
    throw new CloudWakeAwsError(AWS_ERROR_CODES.has(code) ? code : "AwsError", status);
  }
  const instances = child(root, "instancesSet");
  const instance = child(instances, "item");
  const current = child(instance, "currentState");
  const stateName = value(child(current, "name"));
  const stateCode = value(child(current, "code"));
  if (status !== 200 || dryRun || root.name !== "StartInstancesResponse" || !childrenOnly(root, ["requestId", "instancesSet"])
    || !instances || !childrenOnly(instances, ["item"]) || !instance || !childrenOnly(instance, ["instanceId", "currentState", "previousState"])
    || value(child(instance, "instanceId")) !== target.instanceId || !current || !childrenOnly(current, ["code", "name"])
    || !stateCode || !/^[0-9]{1,5}$/.test(stateCode) || Number(stateCode) > 65_535
    || !((stateName === "pending" && (Number(stateCode) & 255) === 0) || (stateName === "running" && (Number(stateCode) & 255) === 16))) {
    throw new CloudWakeAwsError("InvalidResponse", status);
  }
  return { status: "starting", ...requestId(root, "requestId", status) };
}
