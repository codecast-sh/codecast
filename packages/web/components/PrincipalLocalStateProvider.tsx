import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { useConvex, useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AUTH_STORAGE_NAMESPACE } from "@/lib/localAuth";
import { AppLoader } from "@/components/AppLoader";
import {
  bindPrincipalCache,
  discardConversationMessageWrites,
  flushConversationMessages,
  setPrincipalPersistenceErrorHandler,
  suspendPrincipalCache,
  unbindPrincipalCache,
} from "@/store/idbCache";
import {
  clearProtectedInboxMemory,
  hydratePrincipalInboxCache,
  useInboxStore,
} from "@/store/inboxStore";
import { readDurableCredentialEvidence } from "@/store/local-first/credentialBinding";
import { inspectLegacyQuarantine } from "@/store/local-first/legacyQuarantine";
import { DexiePrincipalStoreFactory } from "@/store/local-first/persistence/dexieAdapter";
import { DexieLauncherStore } from "@/store/local-first/persistence/launcher";
import { PrincipalRuntime } from "@/store/local-first/principalRuntime";
import {
  canRenderPrincipalProviderSubtree,
  PrincipalOfflineResolutionCoordinator,
  resolvePrincipalBoot,
  type CredentialResolution,
} from "@/store/local-first/principalVerification";
import {
  registerPrincipalDispatchRuntime,
  updatePrincipalDispatchCorrelation,
} from "@/store/local-first/dispatchGate";
import { requestPersistentStorage } from "@/store/local-first/storagePersistence";
import { asPrincipalId, type PrincipalLifecycle } from "@/store/local-first/types";

let runtimeSingleton: PrincipalRuntime | null = null;
let launcherSingleton: DexieLauncherStore | null = null;
let offlineResolutionSingleton: PrincipalOfflineResolutionCoordinator | null = null;
let principalVerificationProbe = 0;

function getRuntime(): PrincipalRuntime {
  if (runtimeSingleton) return runtimeSingleton;
  const launcher = new DexieLauncherStore(AUTH_STORAGE_NAMESPACE);
  launcherSingleton = launcher;
  const runtime = new PrincipalRuntime(
    launcher,
    new DexiePrincipalStoreFactory(AUTH_STORAGE_NAMESPACE),
    {
      stopProtectedIO: (principalEpoch) => {
        suspendPrincipalCache(principalEpoch);
        (useInboxStore.getState() as any)._clearRuntimeBindings?.();
      },
      clearProtectedMemory: clearProtectedInboxMemory,
      bindPersistence: bindPrincipalCache,
      unbindPersistence: unbindPrincipalCache,
      hydrate: hydratePrincipalInboxCache,
      flushCompatibility: flushConversationMessages,
      discardCompatibility: discardConversationMessageWrites,
      onServerVerified: () => {
        (useInboxStore.getState() as unknown as { _drainOutbox?: () => void })._drainOutbox?.();
      },
      onExternalCommit: async () => {
        // Compatibility projections reload as one durable snapshot. Migrated
        // views will narrow this to the affected keys supplied by the engine.
        const state = runtimeSingleton?.getSnapshot();
        if (!state || (state.phase !== "offline-ready" && state.phase !== "server-verified")) return;
        await hydratePrincipalInboxCache({
          principalEpoch: state.principalEpoch,
          isCurrent: () => runtimeSingleton?.getSnapshot() === state,
        });
      },
    },
  );
  runtimeSingleton = runtime;
  registerPrincipalDispatchRuntime(runtime);
  setPrincipalPersistenceErrorHandler((error) => {
    // Payload-free identity for a failure class we can't reproduce on demand
    // (first-boot only, ct-40156). Dexie hides the subclass behind a factory
    // constructor and wraps the underlying IDB error in `.inner`, so the raw
    // object alone doesn't identify the failure in a captured console.
    const e = error as { name?: string; message?: string; inner?: { name?: string; message?: string } };
    const inner = e?.inner ? ` inner=${e.inner.name}: ${e.inner.message}` : "";
    console.error(
      `[local-first] principal persistence failed: ${e?.name}: ${e?.message}${inner} ` +
      `phase=${runtime.getSnapshot().phase} sinceLoadMs=${Math.round(performance.now())}`,
    );
    runtime.reportStorageFailure(error);
  });
  void inspectLegacyQuarantine().then((status) => {
    if (status.status === "quarantined") void launcher.markLegacyQuarantined();
  }).catch(() => {
    // Quarantine inspection is metadata-only and never affects safe startup.
  });
  return runtime;
}

function getOfflineResolution(runtime: PrincipalRuntime): PrincipalOfflineResolutionCoordinator {
  if (offlineResolutionSingleton) return offlineResolutionSingleton;
  offlineResolutionSingleton = new PrincipalOfflineResolutionCoordinator(
    async (binding) => await runtime.resolveOffline(binding),
  );
  return offlineResolutionSingleton;
}

const PrincipalLocalStateContext = createContext<{
  runtime: PrincipalRuntime;
  state: PrincipalLifecycle;
} | null>(null);

export type { CredentialResolution } from "@/store/local-first/principalVerification";

function PrincipalLocalStateFailure() {
  return (
    <main className="min-h-screen bg-sol-bg text-sol-text flex items-center justify-center p-6">
      <section className="max-w-md rounded-xl border border-sol-border bg-sol-card p-6 shadow-xl">
        <h1 className="text-base font-semibold">Local state is unavailable</h1>
        <p className="mt-2 text-sm text-sol-text-muted">
          CodeCast could not safely verify the account bound to this browser. No cached account data was opened.
        </p>
        <button
          className="mt-5 rounded-md border border-sol-border px-3 py-2 text-sm hover:border-sol-cyan"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </section>
    </main>
  );
}

export function PrincipalLocalStateProvider({ children }: { children: React.ReactNode }) {
  const runtime = useMemo(getRuntime, []);
  const offlineResolution = useMemo(() => getOfflineResolution(runtime), [runtime]);
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const token = useAuthToken();
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  // Exact access-token correlation is deliberately kept in memory. A token
  // change invalidates render permission synchronously, before the effect that
  // resolves/opens/clears any principal store gets a chance to run.
  const [authorizedToken, setAuthorizedToken] = useState<string | null>(null);
  const [credentialResolution, setCredentialResolution] = useState<CredentialResolution | null>(null);
  const verificationCaptureRef = useRef({ token, isAuthenticated, generation: 0 });
  if (verificationCaptureRef.current.token !== token ||
    verificationCaptureRef.current.isAuthenticated !== isAuthenticated) {
    verificationCaptureRef.current = {
      token,
      isAuthenticated,
      generation: verificationCaptureRef.current.generation + 1,
    };
  }

  useEffect(() => {
    let cancelled = false;
    const capture = verificationCaptureRef.current;
    const isCurrentCapture = () => !cancelled &&
      verificationCaptureRef.current.generation === capture.generation &&
      verificationCaptureRef.current.token === capture.token &&
      verificationCaptureRef.current.isAuthenticated === capture.isAuthenticated;
    void (async () => {
      let evidence;
      try {
        evidence = await readDurableCredentialEvidence();
      } catch (error) {
        if (!isCurrentCapture()) return;
        try { await runtime.failClosed("credential-evidence-read-failed"); } catch {}
        setAuthorizedToken(null);
        setCredentialResolution({ token: capture.token, status: "error" });
        return;
      }
      if (!isCurrentCapture()) return;
      if (!evidence) {
        await runtime.resolveOffline(null);
        if (isCurrentCapture()) {
          setAuthorizedToken(null);
          setCredentialResolution({ token: capture.token, status: "none" });
        }
        return;
      }

      // Cached rendering and server verification are two phases, not competing
      // auth branches. Open the exact previously verified credential namespace
      // first; the unique server probe upgrades it in place for apply/dispatch.
      const outcome = await resolvePrincipalBoot({
        token: capture.token,
        evidence,
        serverAuthenticated: capture.isAuthenticated,
        isCurrent: isCurrentCapture,
        resolveOffline: async (credentialBinding) =>
          await offlineResolution.resolve(credentialBinding),
        onOfflineReady: () => {
          if (!isCurrentCapture()) return;
          setAuthorizedToken(capture.token);
          setCredentialResolution({ token: capture.token, status: "ready" });
        },
        // A reactive useQuery value may briefly belong to the previous access
        // token. This unique one-shot query always round-trips, while the local
        // store opens in parallel. Late A responses remain observation-only.
        queryCurrentPrincipal: async () => await convex.query(
          api.users.getCurrentUserProbe,
          { _probe: ++principalVerificationProbe },
        ),
        verify: async (credentialBinding, principalId) => {
          const verified = await runtime.verify({
            credentialBinding,
            principalId: asPrincipalId(principalId),
          });
          // Persistence capability is important for offline writes, but it
          // must not extend the auth/boot dispatch window. Until this settles,
          // offline writes fail closed while reads and online dispatch remain
          // available.
          if (verified) void requestPersistentStorage();
          return verified;
        },
        failClosed: async (reason) => await runtime.failClosed(reason),
        // A transport failure is not an identity failure. Keep the verified
        // cached namespace readable; Convex auth/reconnect will retry later,
        // while dispatch stays disabled in offline-ready.
        onVerificationUnavailable: (error) => {
          console.warn("[local-first] principal verification unavailable; using cached state", error);
        },
      });
      if (!isCurrentCapture() || outcome.kind === "stale" || outcome.kind === "offline-ready") {
        return;
      }
      const ready = outcome.kind === "ready";
      setAuthorizedToken(ready ? capture.token : null);
      setCredentialResolution({
        token: capture.token,
        status: ready ? "ready" : "unverified",
      });
    })().catch(async (error) => {
      if (!isCurrentCapture()) return;
      try { await runtime.failClosed("principal-runtime-failed"); } catch {}
      if (isCurrentCapture()) {
        setAuthorizedToken(null);
        setCredentialResolution({ token: capture.token, status: "error" });
      }
      console.error("[local-first] principal runtime failed", error);
    });
    return () => { cancelled = true; };
  }, [runtime, offlineResolution, convex, token, isAuthenticated]);

  useEffect(() => {
    const reconcile = () => {
      void runtime.reconcileLauncherGeneration().catch(async () => {
        try { await runtime.failClosed("launcher-reconciliation-failed"); } catch {}
      });
    };
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    // bfcache restore: the canonical signal is pageshow (persisted=true). A
    // restored tab may have missed launcher-generation broadcasts and commit
    // notifications while frozen; durable commits are already fenced, but the
    // RENDERED state must reconcile before the user reads it.
    window.addEventListener("pageshow", reconcile);
    return () => {
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("pageshow", reconcile);
    };
  }, [runtime]);

  const value = useMemo(() => ({ runtime, state }), [runtime, state]);
  const mayRender = canRenderPrincipalProviderSubtree({
    state,
    token,
    authorizedToken,
    credentialResolution,
  });
  updatePrincipalDispatchCorrelation(
    mayRender && state.phase === "server-verified" ? state.principalEpoch : null,
  );
  useEffect(() => () => updatePrincipalDispatchCorrelation(null), []);
  return (
    <PrincipalLocalStateContext.Provider value={value}>
      {state.phase === "failed" ||
        (credentialResolution?.token === token && credentialResolution.status === "error")
        ? <PrincipalLocalStateFailure />
        : mayRender ? children : <AppLoader />}
    </PrincipalLocalStateContext.Provider>
  );
}

export function usePrincipalLocalState() {
  const context = useContext(PrincipalLocalStateContext);
  if (!context) throw new Error("usePrincipalLocalState must be used under PrincipalLocalStateProvider");
  return context;
}

export function getPrincipalRuntimeForSignOut(): PrincipalRuntime {
  return getRuntime();
}

export function closePrincipalRuntimeForTests(): void {
  setPrincipalPersistenceErrorHandler(null);
  runtimeSingleton?.close();
  launcherSingleton?.close();
  runtimeSingleton = null;
  launcherSingleton = null;
  offlineResolutionSingleton = null;
  registerPrincipalDispatchRuntime(null);
}
