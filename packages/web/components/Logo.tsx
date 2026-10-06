import { CODECAST_MARK_ARROW_PATH as ARROW_PATH, CODECAST_MARK_C_PATH as C_PATH, CODECAST_MARK_VIEWBOX } from "@codecast/shared/render/codecastMark";

interface LogoProps {
  size?: "sm" | "md" | "lg" | "xl";
  showText?: boolean;
  className?: string;
}

const sizes = {
  sm: { icon: 18, text: "text-base" },
  md: { icon: 24, text: "text-lg" },
  lg: { icon: 32, text: "text-xl" },
  xl: { icon: 40, text: "text-2xl" },
};


function LogoPaths({ monochrome }: { monochrome?: boolean }) {
  return (
    <>
      {/* C shape - gray. Follows the theme via --logo-c (see globals.css: dark
          mode lightens it — the light-mode #444 C vanishes on dark backgrounds).
          Pages with theme-independent light chrome pin it via [--logo-c:#444444]. */}
      <path fill={monochrome ? "currentColor" : "var(--logo-c, #444444)"} d={C_PATH} />
      {/* Play arrow - coral, reads well on both themes */}
      <path fill={monochrome ? "currentColor" : "#e86c5d"} d={ARROW_PATH} />
    </>
  );
}

/** The bare mark, tight-cropped. `monochrome` renders it in currentColor for tinting. */
export function LogoMark({
  size = 24,
  monochrome = false,
  className = "",
}: {
  size?: number;
  monochrome?: boolean;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={CODECAST_MARK_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <LogoPaths monochrome={monochrome} />
    </svg>
  );
}

export function Logo({ size = "md", showText = true, className = "" }: LogoProps) {
  const { icon, text } = sizes[size];

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <LogoMark size={icon} className="shrink-0" />
      {showText && (
        <span className={`font-semibold tracking-tight ${text} text-sol-text`}>
          codecast
        </span>
      )}
    </div>
  );
}

export function LogoIcon({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <LogoPaths />
    </svg>
  );
}
