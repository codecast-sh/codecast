import { Check, Info, TriangleAlert, X } from "lucide-react";
import { Toaster as Sonner } from "sonner";
import { useTheme } from "../ThemeProvider";
import "./sonner.css";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const GLYPH = { size: 13, strokeWidth: 2.5, "aria-hidden": true } as const;

/** The app's toast. Sonner owns placement, stacking, swipe and the enter and
 *  leave motion; sonner.css owns the face. Custom card toasts (`toast.custom`)
 *  paint themselves and never get the close control, so they own dismissal.
 *  A toast that must stay spreads `persistentToast` (lib/persistentToast.ts). */
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
