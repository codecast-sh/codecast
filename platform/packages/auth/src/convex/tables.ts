// Table and index names the auth functions read and write. Every app that
// adopts the package can rename them; the defaults are the names codecast uses.
export type AuthTables = {
  users: string;
  usersEmailIndex: string;
  apiTokens: string;
  apiTokensByHashIndex: string;
  apiTokensByUserIndex: string;
  cliAuthRequests: string;
  cliAuthRequestsByNonceIndex: string;
  cliAuthRequestsByCreatedIndex: string;
};

export const DEFAULT_AUTH_TABLES: AuthTables = {
  users: "users",
  usersEmailIndex: "email",
  apiTokens: "api_tokens",
  apiTokensByHashIndex: "by_token_hash",
  apiTokensByUserIndex: "by_user_id",
  cliAuthRequests: "cli_auth_requests",
  cliAuthRequestsByNonceIndex: "by_nonce_hash",
  cliAuthRequestsByCreatedIndex: "by_created_at",
};

export function resolveTables(overrides?: Partial<AuthTables>): AuthTables {
  return { ...DEFAULT_AUTH_TABLES, ...(overrides ?? {}) };
}

/** The minimal ctx shape every pure helper in this package needs. */
export type DbCtx = { db: any };
