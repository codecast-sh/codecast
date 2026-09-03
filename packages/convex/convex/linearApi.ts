// Linear GraphQL client for issue sync (S5, S6).
//
// Plain functions, not convex actions: every caller is already inside an
// issueSync action that holds the token, and keeping these callable directly
// means the sync engine reads as one function instead of a chain of runAction
// hops. Errors surface as thrown Errors carrying Linear's own message —
// pushTask catches them and records external.last_error rather than retrying
// in a loop (the 15 minute reconcile is the retry, S5).

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;

/** Fields every issue read asks for, so the webhook and pull paths normalize identically. */
const ISSUE_FIELDS = `
  id
  identifier
  url
  number
  title
  description
  priority
  updatedAt
  createdAt
  state { id name type }
  team { id key }
  project { id }
  assignee { id name email }
  labels { nodes { id name } }
`;

export async function linearGraphql<T = any>(
  token: string,
  query: string,
  variables: Record<string, any> = {},
): Promise<T> {
  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Linear API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const body = await res.json();
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    throw new Error(`Linear GraphQL: ${body.errors.map((e: any) => e?.message ?? "error").join("; ")}`);
  }
  return body?.data as T;
}

/* ---------------- Reads ---------------- */

export type LinearIssuePage = { nodes: any[]; hasNextPage: boolean; endCursor?: string };

/**
 * One page of issues from a project or a team, newest edits first.
 *
 * `updatedAfter` is what makes the reconcile cheap: it asks only for issues
 * that moved since the last pull, so a steady-state source costs one empty
 * page every 15 minutes.
 */
export async function fetchIssuesPage(
  token: string,
  opts: {
    projectId?: string;
    teamId?: string;
    updatedAfter?: number;
    after?: string;
    /** Pull each issue's comments in the same round trip (import path). */
    withComments?: boolean;
  },
): Promise<LinearIssuePage> {
  const filter: Record<string, any> = {};
  if (opts.projectId) filter.project = { id: { eq: opts.projectId } };
  if (opts.teamId) filter.team = { id: { eq: opts.teamId } };
  if (opts.updatedAfter) filter.updatedAt = { gte: new Date(opts.updatedAfter).toISOString() };

  // GraphQL lets the comments ride along, so an import of 50 issues is one
  // request rather than 51. Without it a large import is all latency.
  const comments = opts.withComments
    ? `comments(first: 50) { nodes { id body url createdAt updatedAt user { id name email } } }`
    : "";

  const data = await linearGraphql(
    token,
    `query Issues($filter: IssueFilter, $after: String) {
       issues(filter: $filter, first: 50, after: $after, orderBy: updatedAt) {
         nodes { ${ISSUE_FIELDS} ${comments} }
         pageInfo { hasNextPage endCursor }
       }
     }`,
    { filter, after: opts.after },
  );
  const issues = data?.issues;
  return {
    nodes: issues?.nodes ?? [],
    hasNextPage: !!issues?.pageInfo?.hasNextPage,
    endCursor: issues?.pageInfo?.endCursor ?? undefined,
  };
}

export async function fetchIssue(token: string, id: string): Promise<any | null> {
  const data = await linearGraphql(token, `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id });
  return data?.issue ?? null;
}

export async function fetchIssueComments(token: string, issueId: string): Promise<any[]> {
  const data = await linearGraphql(
    token,
    `query IssueComments($id: String!) {
       issue(id: $id) {
         id
         comments(first: 50) {
           nodes { id body url createdAt updatedAt user { id name email } }
         }
       }
     }`,
    { id: issueId },
  );
  return data?.issue?.comments?.nodes ?? [];
}

export async function fetchTeams(token: string): Promise<Array<{ id: string; key: string; name: string }>> {
  const data = await linearGraphql(token, `query Teams { teams(first: 100) { nodes { id key name } } }`);
  return data?.teams?.nodes ?? [];
}

export async function fetchProjects(
  token: string,
): Promise<Array<{ id: string; name: string; url?: string; teams?: { nodes: Array<{ id: string; key: string }> } }>> {
  const data = await linearGraphql(
    token,
    `query Projects { projects(first: 100) { nodes { id name url teams { nodes { id key } } } } }`,
  );
  return data?.projects?.nodes ?? [];
}

export async function fetchWorkflowStates(
  token: string,
  teamId: string,
): Promise<Array<{ id: string; name: string; type: string }>> {
  const data = await linearGraphql(
    token,
    `query States($teamId: ID!) {
       workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) {
         nodes { id name type position }
       }
     }`,
    { teamId },
  );
  const nodes: any[] = data?.workflowStates?.nodes ?? [];
  // Position order is the team's own column order, which is what makes "the
  // first state of this type" the state a human would have picked (S5).
  return [...nodes].sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));
}

export async function fetchLabels(
  token: string,
  teamId: string,
): Promise<Array<{ id: string; name: string }>> {
  const data = await linearGraphql(
    token,
    `query Labels($teamId: ID!) {
       issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 250) { nodes { id name } }
     }`,
    { teamId },
  );
  return data?.issueLabels?.nodes ?? [];
}

export async function findUserByEmail(token: string, email: string): Promise<{ id: string; email: string } | null> {
  const data = await linearGraphql(
    token,
    `query UserByEmail($email: String!) {
       users(filter: { email: { eq: $email } }, first: 1) { nodes { id email } }
     }`,
    { email },
  );
  return data?.users?.nodes?.[0] ?? null;
}

/* ---------------- Writes ---------------- */

export type LinearIssueInput = {
  title?: string;
  description?: string;
  stateId?: string;
  priority?: number;
  assigneeId?: string | null;
  labelIds?: string[];
  teamId?: string;
  projectId?: string;
};

export async function updateIssue(token: string, id: string, input: LinearIssueInput): Promise<any> {
  const data = await linearGraphql(
    token,
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
       issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
     }`,
    { id, input },
  );
  if (!data?.issueUpdate?.success) throw new Error("Linear issueUpdate returned success: false");
  return data.issueUpdate.issue;
}

export async function createIssue(token: string, input: LinearIssueInput): Promise<any> {
  const data = await linearGraphql(
    token,
    `mutation CreateIssue($input: IssueCreateInput!) {
       issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
     }`,
    { input },
  );
  if (!data?.issueCreate?.success) throw new Error("Linear issueCreate returned success: false");
  return data.issueCreate.issue;
}

export async function createComment(
  token: string,
  issueId: string,
  body: string,
): Promise<{ id: string; url?: string }> {
  const data = await linearGraphql(
    token,
    `mutation CreateComment($input: CommentCreateInput!) {
       commentCreate(input: $input) { success comment { id url } }
     }`,
    { input: { issueId, body } },
  );
  const comment = data?.commentCreate?.comment;
  if (!data?.commentCreate?.success || !comment?.id) {
    throw new Error("Linear commentCreate returned no comment");
  }
  return { id: comment.id, url: comment.url ?? undefined };
}

export async function createLabel(token: string, teamId: string, name: string): Promise<{ id: string; name: string }> {
  const data = await linearGraphql(
    token,
    `mutation CreateLabel($input: IssueLabelCreateInput!) {
       issueLabelCreate(input: $input) { success issueLabel { id name } }
     }`,
    { input: { teamId, name } },
  );
  const label = data?.issueLabelCreate?.issueLabel;
  if (!label?.id) throw new Error(`Linear issueLabelCreate failed for '${name}'`);
  return label;
}

/* ---------------- Webhook plumbing (S6) ---------------- */

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Linear signs the RAW body with the webhook secret and sends the hex digest
 * in `Linear-Signature`. Verify against the exact bytes received: a
 * re-serialized JSON body has different whitespace and will never match.
 */
export async function verifyLinearSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqualHex(header.trim().toLowerCase(), expected);
}

/**
 * The dedupe key for one delivery (S1.4). Linear sends `webhookId` on every
 * delivery and `webhookTimestamp` per attempt; together they identify the
 * event. Older payloads omit webhookId, so the type and subject id stand in.
 */
export function linearDeliveryId(payload: any): string {
  const subject = `${payload?.type ?? "event"}:${payload?.data?.id ?? "unknown"}`;
  return `${payload?.webhookId ?? subject}:${payload?.webhookTimestamp ?? ""}`;
}
