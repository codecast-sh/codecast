import { useMountEffect } from "../hooks/useMountEffect";
import { BootFallback } from "./BootFallback";

/**
 * A route that belongs to a standalone boot, reached by a navigation inside
 * the app. The app's router cannot render it (the page is built to run with
 * no auth provider and no store, see main.tsx), so the address is loaded
 * again as a document, which lands in the boot that can.
 */
export function ReloadOutsideApp() {
  useMountEffect(() => {
    window.location.replace(window.location.href);
  });
  return <BootFallback />;
}
