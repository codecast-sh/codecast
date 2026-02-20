"use client";

import { useState } from "react";

type ForkChild = {
  _id: string;
  title: string;
  short_id?: string;
  started_at?: number;
  username?: string;
  parent_message_uuid?: string;
};

export function BranchSelector({
  forkChildren,
  activeBranchId,
  onSwitchBranch,
  loadingBranchId,
}: {
  forkChildren: ForkChild[];
  activeBranchId: string | null;
  onSwitchBranch: (convId: string | null) => void;
  loadingBranchId?: string | null;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-1 mt-2 ml-8 flex-wrap">
      <svg className="w-3 h-3 text-sol-cyan flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
      </svg>
      <button
        onClick={() => onSwitchBranch(null)}
        onMouseEnter={() => setHoveredId("main")}
        onMouseLeave={() => setHoveredId(null)}
        className={`text-[10px] px-2 py-0.5 rounded-sm border transition-all ${
          !activeBranchId
            ? "bg-sol-cyan/15 text-sol-cyan border-sol-cyan/40 font-medium"
            : hoveredId === "main"
              ? "bg-sol-bg-alt text-sol-text-secondary border-sol-border"
              : "text-sol-text-dim border-transparent hover:border-sol-border"
        }`}
      >
        main
      </button>
      {forkChildren.map((fork) => {
        const isActive = activeBranchId === fork._id;
        const isLoading = loadingBranchId === fork._id;
        const label = fork.short_id
          ? `${fork.short_id} ${fork.title}`
          : fork.title;

        return (
          <button
            key={fork._id}
            onClick={() => onSwitchBranch(fork._id)}
            onMouseEnter={() => setHoveredId(fork._id)}
            onMouseLeave={() => setHoveredId(null)}
            className={`text-[10px] px-2 py-0.5 rounded-sm border transition-all max-w-[200px] truncate ${
              isActive
                ? "bg-sol-cyan/15 text-sol-cyan border-sol-cyan/40 font-medium"
                : hoveredId === fork._id
                  ? "bg-sol-bg-alt text-sol-text-secondary border-sol-border"
                  : "text-sol-text-dim border-transparent hover:border-sol-border"
            }`}
            title={fork.title}
          >
            {isLoading ? (
              <span className="flex items-center gap-1">
                <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                {label}
              </span>
            ) : (
              label
            )}
          </button>
        );
      })}
    </div>
  );
}
