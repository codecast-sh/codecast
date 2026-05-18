import { useInboxStore } from "../store/inboxStore";

export function useCurrentUser() {
  const user = useInboxStore((s) => s.currentUser);

  return {
    user,
    isLoading: user === undefined,
    isAuthenticated: user !== null && user !== undefined,
  };
}
