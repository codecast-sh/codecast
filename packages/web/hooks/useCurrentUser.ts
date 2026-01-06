import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

export function useCurrentUser() {
  const user = useQuery(api.users.getCurrentUser);

  return {
    user,
    isLoading: user === undefined,
    isAuthenticated: user !== null && user !== undefined,
  };
}
