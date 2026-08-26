import { Outlet } from "react-router";

/**
 * The layout for a window with no background.
 *
 * Two routes need this: the command palette, which is a card floating over the
 * screen, and the floating faces, which is a circle of somebody's face over
 * their work. Both live in a frameless transparent Electron window, and both
 * would be a grey rectangle without this — the app's own `body` background is
 * painted by globals.css and would fill the window's glass.
 */
export function TransparentWindowLayout() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        html, body { background: transparent !important; }
      `}} />
      <Outlet />
    </>
  );
}
