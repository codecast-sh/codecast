import { LogoMark } from "./Logo";

// Rendered above all providers (incl. ThemeProvider), so it can't rely on
// theme CSS variables — colors are hardcoded, the same as the #boot-shell in
// index.html, whose inline script has already put the theme's classes on
// <html>: a light theme gets the light frame, not a dark flash before the app.
// The mark and shimmer bar both draw via currentColor, so they stay safe here;
// keep the form in sync with AppLoader / the #boot-shell in index.html.
function bootColors(): { background: string; color: string } {
  const cls = typeof document === "undefined" ? null : document.documentElement.classList;
  const dark = cls?.contains("dark") ?? true;
  if (cls?.contains("minimal-style")) return dark ? { background: "#161615", color: "#898781" } : { background: "#ffffff", color: "#72726f" };
  return dark ? { background: "#002b36", color: "#93a1a1" } : { background: "#FBF5E2", color: "#657b83" };
}

export function BootFallback() {
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
        ...bootColors(),
      }}
    >
      <LogoMark size={44} monochrome className="opacity-45" />
      <div className="app-loader-bar" />
    </div>
  );
}
