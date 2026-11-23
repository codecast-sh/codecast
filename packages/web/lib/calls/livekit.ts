// livekit-client is half a megabyte of module the app evaluated at boot for
// everyone, though only a call uses it. The call modules import its types
// statically and read its values here, through `LK`, which holds the module
// once it has loaded. Every path that makes a Room (a join, a prewarm, the
// device list) awaits `loadLivekit()` first, and everything else runs on a
// room or track that already exists, so it is always loaded by then. The app
// also loads it once it goes idle after boot, so a first press does not wait.
type Livekit = typeof import("livekit-client");

export let LK: Livekit = null as unknown as Livekit;
let loading: Promise<Livekit> | null = null;

export function loadLivekit(): Promise<Livekit> {
  if (!loading) {
    const p = import("livekit-client").then((m) => (LK = m));
    // A failed fetch (offline) is retried by the next call, and a caller that
    // stops before awaiting leaves no unhandled rejection behind.
    p.catch(() => { if (loading === p) loading = null; });
    loading = p;
  }
  return loading;
}

/** A module that imports livekit-client statically (the guest call page) hands it over, so the shared call code can read it at once. */
export function provideLivekit(m: Livekit): void {
  LK = m;
  loading ??= Promise.resolve(m);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  setTimeout(() => {
    const idle = (window as any).requestIdleCallback as ((fn: () => void, o?: { timeout: number }) => void) | undefined;
    if (idle) idle(() => void loadLivekit(), { timeout: 15_000 });
    else void loadLivekit();
  }, 8_000);
}
