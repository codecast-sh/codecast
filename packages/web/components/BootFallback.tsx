import { AppLoader } from "./AppLoader";
import { LogoMark } from "./Logo";
import { onLanePage } from "./simple/laneBoot";

// Rendered above all providers (incl. ThemeProvider), so it can't rely on
// theme CSS variables — colors are hardcoded to match the Electron window bg.
// The mark and shimmer bar both draw via currentColor, so they stay safe here;
// keep the form in sync with AppLoader / the #boot-shell in index.html.
// A simple lane page is the exception: its loader reads only the --pd-* sheet
// index.html carries, so it can show the lane's own form here too.
export function BootFallback() {
  if (onLanePage()) return <AppLoader />;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        background: "#002b36",
        color: "#93a1a1",
      }}
    >
      <LogoMark size={44} monochrome className="opacity-45" />
      <div className="app-loader-bar" />
    </div>
  );
}
