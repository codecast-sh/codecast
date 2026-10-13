// A part of the page that loads in its own chunk the first time it is drawn
// or asked for (preload: on idle, or when a pointer heads for the button
// that opens it), so the app's link carries only what it shows at once.
// Once loaded it draws at once, every time: React.lazy would suspend once
// more on a fresh mount and hold its fallback for 300ms.
import { useEffect, useState, type ComponentType } from "react";

export type LazyPart<P> = ComponentType<P> & { preload: () => Promise<unknown> };

export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>): LazyPart<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const preload = () =>
    (loading ??= load().then(
      (part) => (loaded = part),
      (err) => {
        loading = null;
        throw err;
      },
    ));

  function Part(props: P) {
    const [Loaded, setLoaded] = useState(() => loaded);
    useEffect(() => {
      if (!Loaded) preload().then((part) => setLoaded(() => part), () => {});
    }, [Loaded]);
    return Loaded ? <Loaded {...props} /> : null;
  }
  return Object.assign(Part, { preload });
}
