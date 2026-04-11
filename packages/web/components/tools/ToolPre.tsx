import { useState, type ReactNode } from "react";
import { WrapText } from "lucide-react";

interface ToolPreProps {
  children: ReactNode;
  className?: string;
}

export function ToolPre({ children, className = "" }: ToolPreProps) {
  const [wrapped, setWrapped] = useState(false);

  return (
    <div className="relative group/toolpre">
      <button
        onClick={() => setWrapped(w => !w)}
        className={`absolute right-1.5 top-1.5 p-1 rounded opacity-0 group-hover/toolpre:opacity-100 transition-opacity z-10 select-none ${
          wrapped ? "text-sol-cyan" : "text-sol-text-dim/60 hover:text-sol-text-secondary"
        }`}
        title={wrapped ? "Disable line wrap" : "Wrap lines"}
      >
        <WrapText size={13} />
      </button>
      <pre
        className={className}
        style={wrapped ? { whiteSpace: "pre-wrap", wordBreak: "break-word", overflowX: "hidden" } : undefined}
      >
        {children}
      </pre>
    </div>
  );
}
