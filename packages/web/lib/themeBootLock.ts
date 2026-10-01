/**
 * Routes that open in light Classic before anything mounts. The boot script in
 * index.html leaves the root unthemed on these, and ThemeProvider starts with
 * its lock held, so the visitor's stored theme never reaches the root there;
 * MarketingLayout's own lock takes over once it mounts and lets go when the
 * visitor leaves for the app. index.html cannot import this, so its check
 * repeats the same paths: keep the two in step.
 */
export function lockedAtBoot(pathname: string): boolean {
  return pathname === "/";
}
