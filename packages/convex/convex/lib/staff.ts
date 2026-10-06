// Codecast operator access. Never read `users.role` for this: team creation
// writes role "admin" onto the creator, so it marks every team founder.
export function isStaff(user: { staff?: boolean } | null | undefined): boolean {
  return user?.staff === true;
}
