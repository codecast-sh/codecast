"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const { signOut } = useAuthActions();
  const router = useRouter();

  const handleLogout = async () => {
    await signOut();
    router.push("/");
  };

  return (
    <button
      onClick={handleLogout}
      className="px-4 py-2 text-sm text-sol-base0 hover:text-white transition-colors"
    >
      Sign Out
    </button>
  );
}
