import { Link as RRLink } from "react-router";
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children?: ReactNode;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(
  ({ href, prefetch, replace, scroll, ...props }, ref) => {
    if (href.startsWith("http") || href.startsWith("mailto:") || href.startsWith("#")) {
      return <a href={href} ref={ref} {...props} />;
    }
    return <RRLink to={href} replace={replace} ref={ref} {...props} />;
  }
);

Link.displayName = "Link";

export default Link;
