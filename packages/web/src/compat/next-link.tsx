import { Link as RRLink } from "react-router";
import { forwardRef, useCallback, type AnchorHTMLAttributes, type ReactNode } from "react";
import { shouldUseTabRouting, tabNavigate } from "./tabRouting";

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children?: ReactNode;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(
  ({ href, prefetch, replace, scroll, onClick, ...props }, ref) => {
    const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
      if (onClick) onClick(e);
      if (e.defaultPrevented) return;
      // When tabs are active and we're inside the dashboard shell, navigate within
      // the active tab instead of via React Router. A link click pushes a history
      // entry (back/forward traversable) unless the caller asked to replace.
      if (shouldUseTabRouting(href)) {
        e.preventDefault();
        tabNavigate(href, replace ? "replace" : "push");
      }
    }, [href, onClick, replace]);

    if (href.startsWith("http") || href.startsWith("mailto:") || href.startsWith("#")) {
      return <a href={href} ref={ref} onClick={onClick} {...props} />;
    }
    return <RRLink to={href} replace={replace} ref={ref} onClick={handleClick} {...props} />;
  }
);

Link.displayName = "Link";

export default Link;
