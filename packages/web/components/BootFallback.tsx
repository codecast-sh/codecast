// Rendered above all providers (incl. ThemeProvider), so it can't rely on
// theme CSS variables — colors are hardcoded to match the Electron window bg.
export function BootFallback() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#002b36",
        color: "#93a1a1",
      }}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        className="animate-spin"
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  );
}
