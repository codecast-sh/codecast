import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLinger } from "../lib/useLinger";
import { Button } from "./Button";
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

/** One toast at a time, top center, on glass: drops in, stays (paused while
 *  hovered or focused), fades away. A newer toast replaces the current one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastSpec & { key: number }) | null>(null);
  const [leaving, setLeaving] = useState(false);
  const seq = useRef(0);

  const show = useCallback((t: ToastSpec) => {
    setLeaving(false);
    setToast({ ...t, key: ++seq.current });
  }, []);

  const { hold } = useLinger(toast?.key ?? null, toast?.ms ?? 4000, () => setLeaving(true));

  // Unmount on a timer, not animationend: a hidden tab never runs the fade.
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setToast(null), 200);
    return () => clearTimeout(t);
  }, [leaving]);

  const dismiss = () => setLeaving(true);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Always mounted, so a screen reader hears each toast as it comes. */}
      {createPortal(<p className="sr-only" role="status">{toast && !leaving ? toast.text : ""}</p>, document.body)}
      {toast &&
        createPortal(
          <div
            key={toast.key}
            className={`${s.toast} ${toast.face ? s.withFace : ""} ${leaving ? s.leaving : ""} ${toast.onClick ? s.clickable : ""}`}
            onPointerEnter={() => hold(true)}
            onPointerLeave={() => hold(false)}
            onFocus={() => hold(true)}
            onBlur={() => hold(false)}
            onClick={() => {
              if (!toast.onClick) return;
              toast.onClick();
              dismiss();
            }}
          >
            {toast.face && <Face person={toast.face} size={24} />}
            <span className={s.text}>{toast.text}</span>
            {toast.action && (
              <Button
                variant="text"
                className={s.action}
                onClick={(e) => {
                  e.stopPropagation();
                  toast.action!.onClick();
                  dismiss();
                }}
              >
                {toast.action.label}
              </Button>
            )}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

/** The new-version toast's line (DESIGN 6.2): "v15 is live · Juniper:
 *  summary", or for a restore "v8 is live · Peak undid v7: its summary". */
export function LiveToastText({ version, name, verb, summary }: { version: number; name?: string; verb?: string | null; summary: string }) {
  return (
    <>
      <span className={s.version}>v{version} is live</span>
      {name && <span className={s.who}> · {name}{verb ? ` ${verb}` : ""}:</span>} <span className={s.summary}>{summary}</span>
    </>
  );
}
