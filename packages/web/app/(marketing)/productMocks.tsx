"use client";

/**
 * Hand-built HTML mocks of the product used on the marketing landing page.
 * Real screenshots are too dense to read at page scale; these render the same
 * surfaces at legible sizes with simplified, representative content.
 * Solarized-light palette, matching the page: #fdf6e3 bg, #eee8d5 borders,
 * #002b36 ink, accents #859900 / #b58900 / #268bd2 / #6c71c4 / #2aa198.
 */


function Avatar({ initials, color = "#6c71c4" }: { initials: string; color?: string }) {
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white shrink-0"
      style={{ backgroundColor: color }}
    >
      {initials}
    </span>
  );
}


function MessageSquareIcon({ color }: { color: string }) {
  return <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
}

/** Mirrors EntityIdPill for sessions: blue tint, message icon, the session TITLE (never the raw id). */
function SessionPill({ title }: { title: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] align-baseline" style={{ backgroundColor: "rgba(38,139,210,0.1)", color: "#268bd2", borderColor: "rgba(38,139,210,0.2)" }}>
      <MessageSquareIcon color="#268bd2" />
      {title}
    </span>
  );
}


/**
 * Mirrors DocumentDetailLayout: slim icon-toolbar header, bordered title
 * block, prose body — plus a live collaborator presence chip.
 */
export function DocsMock() {
  return (
    <div className="rounded-xl overflow-hidden font-mono text-left" style={{ backgroundColor: "#FBF5E2", border: "1px solid #e4ddc8" }} role="img" aria-label="Shared doc being edited by a person and an agent together">
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid rgba(147,161,161,0.15)", color: "#657b83" }}>
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        <span className="ml-auto flex items-center gap-1.5 text-[10px]">
          <Avatar initials="A" color="#cb4b16" />
          <span className="flex items-center gap-1 rounded-full px-2 py-0.5" style={{ backgroundColor: "rgba(38,139,210,0.1)", color: "#268bd2" }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "#268bd2" }} /> claude editing
          </span>
        </span>
      </div>
      <div className="px-4 py-2.5" style={{ borderBottom: "1px solid rgba(147,161,161,0.15)" }}>
        <div className="text-[15px] font-semibold" style={{ color: "#002b36" }}>Auth migration plan</div>
        <div className="mt-0.5 text-[10px]" style={{ color: "#93a1a1" }}>doc:auth-migration · updated 4m ago</div>
      </div>
      <div className="space-y-2 px-4 py-3 text-[12px]" style={{ color: "#657b83" }}>
        <div className="font-semibold" style={{ color: "#002b36" }}>Rollout steps</div>
        <div>1. Dual-write sessions to the new token store</div>
        <div>2. Migrate refresh flow behind a flag</div>
        <div className="rounded px-1 -mx-1" style={{ backgroundColor: "rgba(38,139,210,0.12)" }}>3. Rollback: flip the flag, tokens stay valid<span className="inline-block ml-0.5 h-3.5 w-0.5 align-middle" style={{ backgroundColor: "#268bd2" }} /></div>
        <div className="mt-1 rounded-lg p-2.5 text-[11px]" style={{ backgroundColor: "#ffffff", border: "1px solid rgba(147,161,161,0.2)" }}>
          <span style={{ color: "#268bd2" }}>claude</span> — added the rollback section from <SessionPill title="Token store migration" />. Review?
        </div>
      </div>
    </div>
  );
}


/** The iPhone bezel used on the page: dark frame, notch pill, dark screen. */
export function PhoneFrame({ children, className = "", screenClassName = "" }: { children: React.ReactNode; className?: string; screenClassName?: string }) {
  return (
    <div className={`relative bg-[#002b36] rounded-[2.5rem] p-3 shadow-2xl ${className}`}>
      <div className={`bg-[#002b36] rounded-[2rem] overflow-hidden ${screenClassName}`}>
        <div className="h-6 bg-[#002b36] flex items-center justify-center">
          <div className="w-20 h-4 bg-[#073642] rounded-full"></div>
        </div>
        {children}
      </div>
    </div>
  );
}
