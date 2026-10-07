import type { AnchorHTMLAttributes } from "react";
import { isPlainClick, navigate } from "../lib/router";

/** A link to a shell address: a plain click moves in place, any other click
 *  is the browser's (a new tab, a window). */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (!isPlainClick(e)) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
