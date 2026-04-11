/**
 * Patched @radix-ui/react-compose-refs for React 19 compatibility.
 *
 * The original useComposedRefs passes the refs spread as the useCallback
 * dependency array. When any individual ref is an unstable callback (common
 * with Radix internals), React recreates the composed callback on every
 * render. React 19's ref-cleanup feature then detaches the old callback
 * (running cleanup → setState) and attaches the new one, triggering a
 * re-render → infinite loop.
 *
 * Fix: store refs in a useRef and return a stable callback (empty deps).
 * The callback always reads the latest refs from the ref container.
 */
import * as React from "react";

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    return ref(value);
  } else if (ref !== null && ref !== undefined) {
    (ref as React.RefObject<T | null>).current = value;
  }
}

function composeRefs<T>(...refs: (React.Ref<T> | undefined)[]) {
  return (node: T | null) => {
    let hasCleanup = false;
    const cleanups = refs.map((ref) => {
      const cleanup = setRef(ref, node);
      if (!hasCleanup && typeof cleanup === "function") {
        hasCleanup = true;
      }
      return cleanup;
    });
    if (hasCleanup) {
      return () => {
        for (let i = 0; i < cleanups.length; i++) {
          const cleanup = cleanups[i];
          if (typeof cleanup === "function") {
            cleanup();
          } else {
            setRef(refs[i], null);
          }
        }
      };
    }
  };
}

function useComposedRefs<T>(...refs: (React.Ref<T> | undefined)[]) {
  // Store current refs in a ref container so the callback is stable
  const currentRefs = React.useRef(refs);
  currentRefs.current = refs;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useCallback(
    (node: T | null) => {
      const r = currentRefs.current;
      let hasCleanup = false;
      const cleanups = r.map((ref) => {
        const cleanup = setRef(ref, node);
        if (!hasCleanup && typeof cleanup === "function") {
          hasCleanup = true;
        }
        return cleanup;
      });
      if (hasCleanup) {
        return () => {
          for (let i = 0; i < cleanups.length; i++) {
            const cleanup = cleanups[i];
            if (typeof cleanup === "function") {
              cleanup();
            } else {
              setRef(r[i], null);
            }
          }
        };
      }
    },
    [] // stable — reads from currentRefs, never triggers detach/attach cycle
  );
}

export { composeRefs, useComposedRefs };
