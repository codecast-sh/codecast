import { Check, Info, TriangleAlert, X } from "lucide-react";
import { Toaster as Sonner, type ExternalToast } from "sonner";
import { useTheme } from "../ThemeProvider";
import "./sonner.css";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/** Options for a toast that stays until the person closes it. No timer, and
 *  the close control shows all the time; a timed toast reveals it on hover.
 *  Spread these at the call site: `toast.error(msg, { ...persistentToast })`. */
export const persistentToast = {
  duration: Infinity,
  closeButton: true,
  className: "cc-toast-sticky",
} as const satisfies ExternalToast;

const GLYPH = { size: 13, strokeWidth: 2.5, "aria-hidden": true } as const;

/** The app's toast. Sonner owns placement, stacking, swipe and the enter and
 *  leave motion; sonner.css owns the face. Custom card toasts (`toast.custom`)
 *  paint themselves and never get the close control, so they own dismissal. */
const Toaster = (props: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      dir="ltr"
      theme={theme}
      className="cc-toaster"
      closeButton
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
