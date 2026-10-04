import { Check, Info, TriangleAlert, X } from "lucide-react";
import { Toaster as Sonner, toast } from "sonner";
import { useTheme } from "../ThemeProvider";
import { persistentToast } from "../../lib/persistentToast";
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

/** The app's toast. Sonner owns placement, stacking, swipe and the enter and
 *  leave motion; sonner.css owns the face. Custom card toasts (`toast.custom`)
 *  paint themselves and never get the close control, so they own dismissal.
 *  A toast that must stay spreads `persistentToast` (lib/persistentToast.ts);
 *  every error does by default. */
const Toaster = (props: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      dir="ltr"
      theme={theme}
      className="cc-toaster"
      closeButton
      toastOptions={{ classNames: { actionButton: "cc-btn cc-btn-fill cc-btn-cyan" } }}
      icons={{
        success: <Check {...GLYPH} />,
        error: <X {...GLYPH} />,
        info: <Info {...GLYPH} />,
        warning: <TriangleAlert {...GLYPH} />,
        close: <X size={13} strokeWidth={2.25} aria-hidden />,
      }}
      {...props}
    />
  );
};

export { Toaster };
