"use client";
import { useState, useRef, useEffect } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useRouter } from "next/navigation";

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { signOut } = useAuthActions();
  const router = useRouter();
  const user = useQuery(api.users.getCurrentUser);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await signOut();
    router.push("/");
  };

  const displayName = user?.name || user?.email?.split("@")[0] || "User";
  const initials = displayName.slice(0, 1).toUpperCase();

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-8 h-8 rounded-full bg-slate-700 bg-sol-bg-alt flex items-center justify-center text-sol-text text-sol-text hover:bg-slate-600 hover:bg-sol-bg-alt transition-colors"
        aria-label="User menu"
      >
        <span className="text-sm font-medium">{initials}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-sol-base02 bg-sol-bg border border-sol-base01 border-sol-border rounded-lg shadow-lg py-1 z-50">
          <div className="px-4 py-3 border-b border-sol-base01 border-sol-border">
            <p className="text-sm font-medium text-sol-text text-sol-text">{displayName}</p>
            {user?.email && (
              <p className="text-xs text-sol-base0 truncate">{user.email}</p>
            )}
          </div>
          <button
            onClick={() => {
              setOpen(false);
              router.push("/settings");
            }}
            className="w-full px-4 py-2 text-left text-sm text-sol-base1 text-sol-text hover:bg-slate-700 hover:bg-sol-bg-alt transition-colors"
          >
            Settings
          </button>
          <button
            onClick={handleLogout}
            className="w-full px-4 py-2 text-left text-sm text-sol-base1 text-sol-text hover:bg-slate-700 hover:bg-sol-bg-alt transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
