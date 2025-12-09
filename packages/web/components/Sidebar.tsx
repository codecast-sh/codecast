"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

interface SidebarProps {
  filter?: "my" | "team";
  onFilterChange?: (filter: "my" | "team") => void;
  directories?: string[];
  directoryFilter?: string | null;
  onDirectoryFilterChange?: (directory: string | null) => void;
}

const bottomNavItems = [
  {
    href: "/cli",
    label: "CLI Setup",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    ),
  },
];

function getShortPath(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length === 0) return projectPath;
  return parts[parts.length - 1];
}

export function Sidebar({ filter = "my", onFilterChange, directories = [], directoryFilter, onDirectoryFilterChange }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isDashboard = pathname === "/dashboard" || pathname?.startsWith("/dashboard/");

  const handleFilterClick = (newFilter: "my" | "team") => {
    if (!isDashboard) {
      router.push("/dashboard");
    }
    onFilterChange?.(newFilter);
  };

  const handleDirectoryClick = (dir: string) => {
    if (!isDashboard) {
      router.push("/dashboard");
    }
    onDirectoryFilterChange?.(directoryFilter === dir ? null : dir);
  };

  return (
    <nav className="w-64 border-r border-sol-border bg-sol-bg-alt/50 h-[calc(100vh-52px)] p-4 hidden md:flex flex-col sticky top-[52px]">
      <div className="flex-1">
        <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
          Conversations
        </div>
        <div className="space-y-1">
          <button
            onClick={() => handleFilterClick("my")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none text-left ${
              isDashboard && filter === "my"
                ? "bg-sol-bg-alt text-sol-text"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span>Private</span>
          </button>
          <button
            onClick={() => handleFilterClick("team")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none text-left ${
              isDashboard && filter === "team"
                ? "bg-sol-bg-alt text-sol-text"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span>Team</span>
          </button>
        </div>

        {directories.length > 0 && (
          <div className="mt-6">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
              Projects
            </div>
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {directories.slice(0, 10).map((dir) => (
                <button
                  key={dir}
                  onClick={() => handleDirectoryClick(dir)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none text-left ${
                    directoryFilter === dir
                      ? "bg-sol-bg-alt text-sol-text"
                      : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
                  }`}
                  title={dir}
                >
                  <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="truncate">{getShortPath(dir)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-auto pt-4 space-y-1">
        <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide px-3 mb-2">
          Configuration
        </div>
        {bottomNavItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors motion-reduce:transition-none ${
              pathname === item.href || pathname?.startsWith(item.href + "/")
                ? "bg-sol-bg-alt text-sol-text"
                : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt/50"
            }`}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
