import { Link as RRLink, useNavigate } from "react-router";
import { forwardRef, useCallback, type AnchorHTMLAttributes, type ReactNode } from "react";
import { interceptSettingsNav, shouldUseTabRouting, tabNavigate } from "./tabRouting";

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children?: ReactNode;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(
  ({ href, prefetch, replace, scroll, onClick, ...props }, ref) => {
    const navigate = useNavigate();
    const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
      if (onClick) onClick(e);
      if (e.defaultPrevented) return;
      // Modified clicks (cmd/ctrl/middle…) are the browser's: let RRLink fall
      // through to default new-tab handling instead of intercepting.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      // Settings sections open as a modal over the current view, not a route.
      const settings = interceptSettingsNav(href);
      if (settings) {
        e.preventDefault();
        if (settings.carryUrl) navigate(settings.carryUrl, { replace: true });
        return;
      }
      // When tabs are active and we're inside the dashboard shell, navigate within
      // the active tab instead of via React Router. A link click pushes a history
      // entry (back/forward traversable) unless the caller asked to replace.
      if (shouldUseTabRouting(href)) {
        e.preventDefault();
        tabNavigate(href, replace ? "replace" : "push");
      }
    }, [href, onClick, replace, navigate]);

    if (href.startsWith("http") || href.startsWith("mailto:") || href.startsWith("#")) {
      return <a href={href} ref={ref} onClick={onClick} {...props} />;
    }
    return <RRLink to={href} replace={replace} ref={ref} onClick={handleClick} {...props} />;
  }
);

Link.displayName = "Link";

export default Link;
