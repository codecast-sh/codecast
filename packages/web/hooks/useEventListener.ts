import { useEffect, useRef } from "react";

type Target = EventTarget | null | undefined;

export function useEventListener<K extends keyof WindowEventMap>(
  event: K,
  handler: (e: WindowEventMap[K]) => void,
  target?: Target,
  options?: AddEventListenerOptions
): void;
export function useEventListener<K extends keyof DocumentEventMap>(
  event: K,
  handler: (e: DocumentEventMap[K]) => void,
  target: Document,
  options?: AddEventListenerOptions
): void;
export function useEventListener(
  event: string,
  handler: (e: Event) => void,
  target?: Target,
  options?: AddEventListenerOptions
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // eslint-disable-next-line no-restricted-syntax, react-hooks/exhaustive-deps
  useEffect(() => {
    const el: Target = target !== undefined ? target : window;
    if (!el) return;
    const listener = (e: Event) => handlerRef.current(e);
    el.addEventListener(event, listener, options);
    return () => el.removeEventListener(event, listener, options);
  }, [event, target, options?.capture, options?.passive, options?.once]); // eslint-disable-line react-hooks/exhaustive-deps
}
