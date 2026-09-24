import { AuthPrincipalBoundary } from "@platform/auth/web";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import type { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import { authPrincipal } from "./authPrincipal";
import { durableAuthStorage } from "./durableAuthStorage";
import { installAuthPrincipalBoundary } from "../store/principalBoundary";

// The store side of the boundary is installed with the module, before any
// window renders: a principal change that lands while the app is still
// booting must clear and fence the store like any other.
if (!import.meta.hot?.data?.principalBoundaryInstalled) {
  installAuthPrincipalBoundary();
  if (import.meta.hot) import.meta.hot.data.principalBoundaryInstalled = true;
}

/**
 * The auth root every codecast window mounts: the Convex auth provider over
 * the durable token storage, remounted on every principal change so the
 * provider re-reads storage and nothing below it survives an account change.
 */
export function CodecastAuthRoot({ client, children }: { client: ConvexReactClient; children: ReactNode }) {
  return (
    <AuthPrincipalBoundary tracker={authPrincipal}>
      <ConvexAuthProvider client={client} storage={durableAuthStorage}>
        {children}
      </ConvexAuthProvider>
    </AuthPrincipalBoundary>
  );
}
