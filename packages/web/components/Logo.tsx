interface LogoProps {
  size?: "sm" | "md" | "lg" | "xl";
  showText?: boolean;
  className?: string;
}

const sizes = {
  sm: { icon: 20, text: "text-lg" },
  md: { icon: 28, text: "text-xl" },
  lg: { icon: 36, text: "text-2xl" },
  xl: { icon: 48, text: "text-3xl" },
};

export function Logo({ size = "md", showText = true, className = "" }: LogoProps) {
  const { icon, text } = sizes[size];

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
      >
        {/* Outer bracket - left angle */}
        <path
          d="M10 6L3 16L10 26"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-sol-cyan"
        />
        {/* Outer bracket - right angle */}
        <path
          d="M22 6L29 16L22 26"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-sol-cyan"
        />
        {/* Broadcast waves - inner */}
        <path
          d="M12.5 12C13.9 10.6 15.8 10 16 10C16.2 10 18.1 10.6 19.5 12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="text-sol-yellow"
        />
        {/* Broadcast waves - middle */}
        <path
          d="M11 9.5C13.2 7.3 15.5 6.5 16 6.5C16.5 6.5 18.8 7.3 21 9.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="text-sol-orange"
        />
        {/* Center dot */}
        <circle
          cx="16"
          cy="16"
          r="3"
          fill="currentColor"
          className="text-sol-yellow"
        />
        {/* Signal line down */}
        <path
          d="M16 19V25"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="text-sol-yellow"
        />
      </svg>
      {showText && (
        <span className={`font-mono font-semibold tracking-tight ${text}`}>
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
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M10 6L3 16L10 26"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-sol-cyan"
      />
      <path
        d="M22 6L29 16L22 26"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-sol-cyan"
      />
      <path
        d="M12.5 12C13.9 10.6 15.8 10 16 10C16.2 10 18.1 10.6 19.5 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="text-sol-yellow"
      />
      <path
        d="M11 9.5C13.2 7.3 15.5 6.5 16 6.5C16.5 6.5 18.8 7.3 21 9.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="text-sol-orange"
      />
      <circle
        cx="16"
        cy="16"
        r="3"
        fill="currentColor"
        className="text-sol-yellow"
      />
      <path
        d="M16 19V25"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="text-sol-yellow"
      />
    </svg>
  );
}
