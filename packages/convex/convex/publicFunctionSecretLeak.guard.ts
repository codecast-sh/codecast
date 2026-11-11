// Compile-time guard: no public function may return a secret field.
//
// This deployment has no global auth gate, so whatever a public query,
// mutation or action returns is one call away from anyone. On 2026-08-02 two
// public queries returned the raw `users` row, GitHub token included.
//
// The check walks every public function in the generated `api` (so a new
// module or function is covered the moment it exists) and every type its
// handler can return, and fails the convex typecheck naming each
// `module.function: table.field` that can carry a secret. A row with its
// secrets destructured out (getCurrentUserRow in users.ts) passes; the raw
// row does not. A return typed `any` is invisible here, which is why the
// runtime tests in publicFunctionSecretLeak.test.ts still pin the functions
// that serve user profiles.
//
// Two dots in the name keep the Convex bundler from deploying this file;
// convex/tsconfig.json still typechecks it.
import type { FunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import type { api } from "./_generated/api";
import type { Doc, TableNames } from "./_generated/dataModel";

/** Credentials and ciphertexts, by table. Nothing here crosses a public boundary. */
export const SECRET_FIELDS = {
  users: ["github_access_token", "encryption_master_key", "push_token", "voip_push_token", "email_unsub_token"],
  github_installation_tokens: ["token"],
  cli_auth_requests: ["token"],
  vault_upload_tickets: ["token"],
  live_activities: ["activity_token", "push_to_start_token"],
  secrets: ["value_enc"],
  secret_values: ["value_enc"],
  secret_versions: ["value_enc"],
  mod_secrets: ["value_enc"],
} as const satisfies { [T in TableNames]?: readonly (keyof Doc<T>)[] };

type SecretTable = keyof typeof SECRET_FIELDS;
type SecretFieldOf<N> = N extends SecretTable ? (typeof SECRET_FIELDS)[N][number] : never;
type TableOf<T> = T extends { _id: GenericId<infer N> } ? N : never;

// The secret keys an object type carries, as "table.field".
type OwnSecrets<T> = TableOf<T> extends infer N
  ? N extends string
    ? Extract<keyof T, SecretFieldOf<N>> extends infer F
      ? F extends string
        ? `${N}.${F}`
        : never
      : never
    : never
  : never;

// Depth budget: returns nest rows inside receipts, pages and arrays.
type Next = [never, 0, 1, 2, 3, 4, 5];
type IsAny<T> = 0 extends 1 & T ? true : false;

/** Every "table.field" secret reachable in T. */
export type SecretsIn<T, D extends number = 5> = [D] extends [never]
  ? never
  : IsAny<T> extends true
    ? never
    : T extends Promise<infer U>
      ? SecretsIn<U, D>
      : T extends readonly (infer E)[]
        ? SecretsIn<E, Next[D]>
        : T extends object
          ? OwnSecrets<T> | { [K in keyof T]-?: SecretsIn<T[K], Next[D]> }[keyof T]
          : never;

/** "module.function: table.field" for every public function that can return a secret. */
export type PublicSecretReturns<A, P extends string = ""> = {
  [K in keyof A & string]: A[K] extends FunctionReference<any, "public", any, infer R>
    ? [SecretsIn<R>] extends [never]
      ? never
      : `${P}${K}: ${SecretsIn<R>}`
    : PublicSecretReturns<A[K], `${P}${K}.`>;
}[keyof A & string];

// If this fails ("does not satisfy the constraint 'never'"), the error lists
// each "module.function: table.field" that can return a secret. Strip the
// field from what the handler returns (see getCurrentUserRow in users.ts), or
// project the row to the fields its callers render.
type NoneOf<T extends never> = T;
export type NoPublicFunctionReturnsASecret = NoneOf<PublicSecretReturns<typeof api>>;

// The guard must not pass by detecting nothing: a raw row nested in a
// receipt is caught, and the same row with its secrets removed is not.
type Expect<T extends true> = T;
export type GuardSelfTest = [
  Expect<[SecretsIn<Promise<{ page: { row: Doc<"users"> | null }[] }>>] extends [never] ? false : true>,
  Expect<[SecretsIn<Omit<Doc<"users">, SecretFieldOf<"users">>>] extends [never] ? true : false>,
  Expect<[SecretsIn<Doc<"github_installation_tokens">>] extends [never] ? false : true>,
];
