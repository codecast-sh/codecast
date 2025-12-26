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

export function Logo({ size = "md", showText = true, className = "" }: LogoProps) {
  const { icon, text } = sizes[size];

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
      >
        {/* Left bracket */}
        <path
          d="M8 4L3 12L8 20"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-sol-text"
        />
        {/* Right bracket */}
        <path
          d="M16 4L21 12L16 20"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-sol-text"
        />
        {/* Play triangle */}
        <path
          d="M10 8L15 12L10 16V8Z"
          fill="currentColor"
          className="text-sol-cyan"
        />
      </svg>
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
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M8 4L3 12L8 20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-sol-text"
      />
      <path
        d="M16 4L21 12L16 20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-sol-text"
      />
      <path
        d="M10 8L15 12L10 16V8Z"
        fill="currentColor"
        className="text-sol-cyan"
      />
    </svg>
  );
}
