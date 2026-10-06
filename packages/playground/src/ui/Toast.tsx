import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Face, type Person } from "./Face";
import s from "./Toast.module.css";

export type ToastSpec = {
  face?: Pick<Person, "avatar" | "name">;
  text: ReactNode;
  action?: { label: string; onClick: () => void };
  onClick?: () => void;
  ms?: number;
};

const ToastContext = createContext<(t: ToastSpec) => void>(() => {});

export const useToast = () => useContext(ToastContext);

/** One toast at a time, top center: arrives with a squish, stays (paused
 *  while hovered), glides away. A newer toast replaces the current one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastSpec & { key: number }) | null>(null);
  const [leaving, setLeaving] = useState(false);
  const hovered = useRef(false);
  const seq = useRef(0);

  const show = useCallback((t: ToastSpec) => {
    setLeaving(false);
    setToast({ ...t, key: ++seq.current });
  }, []);

  useEffect(() => {
    if (!toast) return;
    let left = toast.ms ?? 4000;
    const tick = setInterval(() => {
      if (!hovered.current) left -= 100;
      if (left <= 0) {
        clearInterval(tick);
        setLeaving(true);
      }
    }, 100);
    return () => clearInterval(tick);
  }, [toast]);

  const dismiss = () => setLeaving(true);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast &&
        createPortal(
          <div
            key={toast.key}
            role="status"
            className={`${s.toast} ${leaving ? s.leaving : ""} ${toast.onClick ? s.clickable : ""}`}
            onAnimationEnd={() => leaving && setToast(null)}
            onPointerEnter={() => (hovered.current = true)}
            onPointerLeave={() => (hovered.current = false)}
            onClick={() => {
              if (!toast.onClick) return;
              toast.onClick();
              dismiss();
            }}
          >
            {toast.face && <Face person={toast.face} size={24} />}
            <span className={s.text}>{toast.text}</span>
            {toast.action && (
              <button
                className={s.action}
                onClick={(e) => {
                  e.stopPropagation();
                  toast.action!.onClick();
                  dismiss();
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}
