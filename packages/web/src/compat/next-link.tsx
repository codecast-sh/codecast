import { Link as RRLink } from "react-router";
import { forwardRef, useCallback, type AnchorHTMLAttributes, type ReactNode } from "react";
import { useInboxStore } from "../../store/inboxStore";

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children?: ReactNode;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

function pathLabel(path: string): string {
  if (path.startsWith("/conversation/")) return "Conversation";
  if (path.startsWith("/tasks/")) return "Task";
  if (path.startsWith("/docs/")) return "Doc";
  const segments: Record<string, string> = {
    "/tasks": "Tasks", "/docs": "Docs", "/plans": "Plans",
    "/projects": "Projects", "/inbox": "Inbox", "/feed": "Feed",
  };
  return segments[path] || path.split("/").pop() || "Tab";
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(
  ({ href, prefetch, replace, scroll, onClick, ...props }, ref) => {
    const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
      if (onClick) onClick(e);
      if (e.defaultPrevented) return;
      // When tabs are active, navigate within the active tab instead of via React Router
      const { tabs, activeTabId } = useInboxStore.getState();
      if (tabs.length > 0 && activeTabId && !href.startsWith("http") && !href.startsWith("mailto:") && !href.startsWith("#")) {
        e.preventDefault();
        useInboxStore.getState().updateTab(activeTabId, { path: href, title: pathLabel(href) });
        window.history.replaceState(null, "", href);
      }
    }, [href, onClick]);

    if (href.startsWith("http") || href.startsWith("mailto:") || href.startsWith("#")) {
      return <a href={href} ref={ref} onClick={onClick} {...props} />;
    }
    return <RRLink to={href} replace={replace} ref={ref} onClick={handleClick} {...props} />;
  }
);

Link.displayName = "Link";

export default Link;
