// Who is using this browser (SPEC "Identity"). The first visit makes a secret,
// proves a little work over it (convex/lib/proof, in a worker so the page
// never stalls for it) and registers it, then keeps the id and secret in
// localStorage; every call carries both. The character comes from the
// backend (defaultCharacterFor until chosen), and a change shows at once
// through an optimistic update of `me`. The last `me` seen is kept too, so a
// returning visitor's page renders on first paint rather than after a round
// trip. A registration that fails is tried again, backing off.
//
// Nothing waits for this that does not need it: an app's page draws and
// loads its app while a newcomer registers, and only what writes, shows who
// you are, or joins the room waits (useMaybeIdentity, or useIdentity in what
// is only drawn once the visitor is known).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { PublicVisitor, VisitorCredentials } from "../../convex/visitors";
import { convex } from "./convex";
import { mintVisitor, solveOffThread } from "./mint";
import { load, save } from "./storage";

const CREDS_KEY = "clayground.visitor";
const ME_KEY = "clayground.me";
/** Waits between registration attempts; the last repeats. */
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];
const TAB_VISITOR_KEY = "clayground.tabVisitor";

/** Dev only: `?visitor=new` makes this tab a new person, kept in
 *  sessionStorage, so two tabs can be two visitors. The param is dropped from
 *  the address once read; the tab stays that person until it closes. */
function tabVisitor(): boolean {
  if (!import.meta.env.DEV) return false;
  const params = new URLSearchParams(location.search);
  if (params.get("visitor") !== "new") return sessionStorage.getItem(TAB_VISITOR_KEY) === "1";
  sessionStorage.setItem(TAB_VISITOR_KEY, "1");
  sessionStorage.removeItem(CREDS_KEY);
  const rest = location.search.slice(1).split("&").filter((p) => p !== "visitor=new").join("&");
  history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  return true;
}

const credsStore: Storage = tabVisitor() ? sessionStorage : localStorage;

type Identity = {
  creds: VisitorCredentials;
  me: PublicVisitor;
  /** True the visit this browser first got a character, for the hello toast. */
  fresh: boolean;
  setCharacter: (patch: { avatar?: string | null; name?: string | null }) => Promise<void>;
};

type Booting = { identity: Identity | null; retry: () => void };

const IdentityContext = createContext<Booting | null>(null);

/** One registration at a time per page, however many effects ask. */
let registering: Promise<VisitorCredentials> | null = null;

function register(): Promise<VisitorCredentials> {
  registering ??= mintVisitor((args) => convex.mutation(api.visitors.register, args), solveOffThread).then(
    (creds) => {
      save(CREDS_KEY, creds, credsStore);
      return creds;
    },
    (err) => {
      registering = null;
      throw err;
    },
  );
  return registering;
}

function storedCreds(): VisitorCredentials | null {
  const c = load<Partial<VisitorCredentials> | null>(CREDS_KEY, null, credsStore);
  return c?.visitor_id && c.secret ? { visitor_id: c.visitor_id, secret: c.secret } : null;
}

// A newcomer starts becoming a visitor as the page loads, alongside
// everything else, rather than after the first render.
if (!storedCreds()) register().catch(() => {});

/** The `me` this browser saw last, while it is still the stored visitor's. */
function storedMe(creds: VisitorCredentials | null): Me | null {
  const m = load<Me | null>(ME_KEY, null, credsStore);
  return creds && m?.visitor?.id === creds.visitor_id ? m : null;
}

type Me = FunctionReturnType<typeof api.visitors.me> & {};

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [creds, setCreds] = useState(storedCreds);
  const [fresh, setFresh] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const asked = useQuery(api.visitors.me, creds ?? "skip");
  const [kept] = useState(() => storedMe(creds));
  useEffect(() => {
    if (asked) save(ME_KEY, asked, credsStore);
  }, [asked]);
  const me = asked === undefined && kept?.visitor.id === creds?.visitor_id ? kept : asked;

  // No credentials, or the backend no longer knows them: register, and keep
  // trying with a growing wait while it fails.
  const lost = asked === null;
  useEffect(() => {
    if (creds && !lost) return;
    if (lost) registering = null;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryOnce = (n: number) =>
      register().then(
        (next) => {
          if (!live) return;
          setFresh(true);
          setCreds(next);
        },
        () => {
          if (live) timer = setTimeout(() => tryOnce(n + 1), RETRY_MS[Math.min(n, RETRY_MS.length - 1)]);
        },
      );
    tryOnce(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [creds, lost, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const set = useMutation(api.visitors.setCharacter).withOptimisticUpdate((store, args) => {
    const key = { visitor_id: args.visitor_id, secret: args.secret };
    const current = store.getQuery(api.visitors.me, key);
    if (!current) return;
    const visitor = { ...current.visitor };
    if (typeof args.avatar === "string") visitor.avatar = args.avatar as PublicVisitor["avatar"];
    if (typeof args.name === "string") visitor.name = args.name;
    store.setQuery(api.visitors.me, key, { visitor, chosen: true });
  });

  const setCharacter = useCallback(
    async (patch: { avatar?: string | null; name?: string | null }) => {
      if (creds) await set({ ...creds, ...patch });
    },
    [creds, set],
  );

  const identity = useMemo(
    () => (creds && me ? { creds, me: me.visitor, fresh, setCharacter } : null),
    [creds, me, fresh, setCharacter],
  );
  const value = useMemo(() => ({ identity, retry }), [identity, retry]);
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

function useBooting(): Booting {
  const booting = useContext(IdentityContext);
  if (!booting) throw new Error("identity outside IdentityProvider");
  return booting;
}

/** Who you are, or null while this browser is still becoming a visitor. */
export const useMaybeIdentity = (): Identity | null => useBooting().identity;

/** Try registering again now, rather than at the next backoff. */
export const useRetryIdentity = () => useBooting().retry;

/** Who you are, in what is only drawn once the visitor is known. */
export function useIdentity(): Identity {
  const { identity } = useBooting();
  if (!identity) throw new Error("useIdentity before the visitor is known: use useMaybeIdentity");
  return identity;
}


type WithoutCreds<F extends FunctionReference<"query" | "mutation">> = Omit<FunctionArgs<F>, keyof VisitorCredentials>;

/** useQuery with this visitor's credentials filled in. */
export function useVisitorQuery<F extends FunctionReference<"query">>(
  fn: F,
  args: WithoutCreds<F> | "skip",
): FunctionReturnType<F> | undefined {
  const { creds } = useIdentity();
  return useQuery(fn as FunctionReference<"query">, args === "skip" ? "skip" : { ...args, ...creds }) as FunctionReturnType<F> | undefined;
}

/** useMutation with this visitor's credentials filled in. */
export function useVisitorMutation<F extends FunctionReference<"mutation">>(fn: F) {
  const { creds } = useIdentity();
  const run = useMutation(fn as FunctionReference<"mutation">);
  return useCallback(
    (args: WithoutCreds<F>) => run({ ...args, ...creds }) as Promise<FunctionReturnType<F>>,
    [run, creds],
  );
}
