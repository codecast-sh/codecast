import { Check, Info, TriangleAlert, X } from "lucide-react";
import { Toaster as Sonner, toast } from "sonner";
import { useTheme } from "../ThemeProvider";
import { persistentToast } from "../../lib/persistentToast";
import { useUndoCardToasterLift } from "../../lib/undoCardToasterLift";
import "./button.css";
import "./sonner.css";

// An error stays until the person closes it: it is often the only word that
// their action did not take, and a timer took it away before it could be read.
// Set once here so every `toast.error` call site gets it; a call that passes
// its own duration still wins.
const timedError = toast.error;
toast.error = (message, data) => timedError(message, { ...persistentToast, ...data });

type ToasterProps = React.ComponentProps<typeof Sonner>;

const GLYPH = { size: 13, strokeWidth: 2.5, "aria-hidden": true } as const;

// The error mark is a "!" in the red chip: an X there read as a second close
// button. Lucide has no bare "!", so this draws one in the same stroke.
const ErrorMark = () => (
  <svg width={GLYPH.size} height={GLYPH.size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={GLYPH.strokeWidth} strokeLinecap="round" aria-hidden>
    <path d="M12 6v8" />
    <path d="M12 18.5h.01" />
  </svg>
);

/** The app's toast. Sonner owns placement, stacking, swipe and the enter and
 *  leave motion; sonner.css owns the face. Custom card toasts (`toast.custom`)
 *  paint themselves and never get the close control, so they own dismissal.
 *  A toast that must stay spreads `persistentToast` (lib/persistentToast.ts);
 *  every error does by default. */
const Toaster = (props: ToasterProps) => {
  const { theme } = useTheme();
  // Above the undo card while it is open: the two share the corner.
  const lift = useUndoCardToasterLift();

  return (
    <Sonner
      dir="ltr"
      theme={theme}
      className="cc-toaster"
      closeButton
      toastOptions={{ classNames: { actionButton: "cc-btn cc-btn-fill cc-btn-cyan" } }}
      icons={{
        success: <Check {...GLYPH} />,
        error: <ErrorMark />,
        info: <Info {...GLYPH} />,
        warning: <TriangleAlert {...GLYPH} />,
        close: <X size={13} strokeWidth={2.25} aria-hidden />,
      }}
      {...props}
      {...(lift ? { offset: lift, mobileOffset: lift } : {})}
    />
  );
};

export { Toaster };
