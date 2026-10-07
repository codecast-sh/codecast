// Who is using this browser (SPEC "Identity"). The first visit makes a secret,
// proves a little work over it (convex/lib/proof) and registers it, then
// keeps the id and secret in localStorage; every call carries both. The
// character comes from the backend (defaultCharacterFor until chosen), and a
// change shows at once through an optimistic update of `me`.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { PublicVisitor, VisitorCredentials } from "../../convex/visitors";
import { convex } from "./convex";
import { mintVisitor } from "./mint";
import { load, save } from "./storage";

const CREDS_KEY = "clayground.visitor";
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

const IdentityContext = createContext<Identity | null>(null);

/** One registration at a time per page, however many effects ask. */
let registering: Promise<VisitorCredentials> | null = null;

function register(): Promise<VisitorCredentials> {
  registering ??= mintVisitor((args) => convex.mutation(api.visitors.register, args)).then((creds) => {
    save(CREDS_KEY, creds, credsStore);
    return creds;
  });
  return registering;
}

function storedCreds(): VisitorCredentials | null {
  const c = load<Partial<VisitorCredentials> | null>(CREDS_KEY, null, credsStore);
  return c?.visitor_id && c.secret ? { visitor_id: c.visitor_id, secret: c.secret } : null;
}

export function IdentityProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [creds, setCreds] = useState(storedCreds);
  const [fresh, setFresh] = useState(false);
  const me = useQuery(api.visitors.me, creds ?? "skip");

  // No credentials, or the backend no longer knows them: register.
  const lost = me === null;
  useEffect(() => {
    if (creds && !lost) return;
    if (lost) registering = null;
    let live = true;
    register().then((next) => {
      if (!live) return;
      setFresh(true);
      setCreds(next);
    });
    return () => {
      live = false;
    };
  }, [creds, lost]);

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

  const value = useMemo(
    () => (creds && me ? { creds, me: me.visitor, fresh, setCharacter } : null),
    [creds, me, fresh, setCharacter],
  );
  return value ? <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider> : fallback;
}

export function useIdentity(): Identity {
  const id = useContext(IdentityContext);
  if (!id) throw new Error("useIdentity outside IdentityProvider");
  return id;
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
