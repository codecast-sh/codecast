import { Outlet } from "react-router";

export function PaletteLayout() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        html, body { background: transparent !important; }
      `}} />
      <Outlet />
    </>
  );
}
