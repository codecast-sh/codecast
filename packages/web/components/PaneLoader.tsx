// A page's loading state inside the shell (routines, a routine, a to-do).
import { AppLoader } from "./AppLoader";

export function PaneLoader({ className = "min-h-[16rem] h-full" }: { className?: string }) {
  return <AppLoader className={className} />;
}
