// A repository's README, rendered the way GitHub renders it.
//
// Nearly every README opens with presentational HTML: a centered logo, a row of
// badges, a `<details>` block. The shared markdown pipeline has no HTML pass,
// so those tags printed as literal text and the first screen of every project
// looked broken. This renderer parses the raw HTML and immediately cuts the
// tree down to the same allowlist the vault applies to arbitrary notes, which
// is the boundary that makes rendering a stranger's README safe. Relative
// links and images resolve against the file in the repository, at the ref the
// page is showing.
import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { MD_COMPONENTS } from "../../lib/markdownComponents";
import { MD_REMARK_PLUGINS } from "../../lib/markdownPlugins";
import { VAULT_HTML_SCHEMA } from "../../lib/vault/htmlPolicy";
import { resolveRepoMarkdownUrl } from "../../lib/repoContent";
import { useRepoBlob, useRepoReadme } from "../../hooks/useRepoBrowse";
import { useRepoTransport } from "../../lib/repoTransport";
import { repoBlobHref, type RepoRouteFamily } from "../../lib/repoView";

// ORDER IS THE SECURITY PROPERTY: rehypeRaw parses the README's inline HTML and
// rehypeSanitize reduces it to the allowlist before anything else runs. See the
// same note on the vault renderer, which this list mirrors.
const README_REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, VAULT_HTML_SCHEMA],
  rehypeHighlight,
];

type ImageProps = { src?: string; alt?: string; width?: string | number; height?: string | number };

/**
 * An image that lives in the repository. A public repository serves it straight
 * from GitHub; a private one has to come through the blob cache, which the
 * signed in read fills.
 */
function RepoImage({ repository, refName, path, alt, width, height }: { repository: string; refName: string; path: string } & Omit<ImageProps, "src">) {
  const mode = useRepoTransport();
  const blob = useRepoBlob(repository, refName, mode === "public" ? undefined : path);
  const size = { width, height };
  if (mode === "public") {
    const raw = `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(refName)}/${path.split("/").map(encodeURIComponent).join("/")}`;
    return <img src={raw} alt={alt ?? ""} {...size} className="inline-block max-w-full h-auto" loading="lazy" />;
  }
  const content = blob.data;
  if (!content || content.truncated) return <span className="text-sol-text-dim">{alt || path}</span>;
  const mime = path.endsWith(".svg") ? "image/svg+xml" : path.match(/\.jpe?g$/i) ? "image/jpeg" : `image/${path.split(".").pop()}`;
  const src = content.base64 ? `data:${mime};base64,${content.base64}` : `data:${mime};charset=utf-8,${encodeURIComponent(content.content)}`;
  return <img src={src} alt={alt ?? ""} {...size} className="inline-block max-w-full h-auto" loading="lazy" />;
}

/** `<h1 align="center">` is how a README centers its name; the shared heading drops the attribute. */
function alignedHeading(Tag: "h1" | "h2" | "h3", className: string) {
  return function AlignedHeading({ children, align }: { children?: ReactNode; align?: string }) {
    return <Tag className={className} style={align ? { textAlign: align as "center" } : undefined}>{children}</Tag>;
  };
}

export function RepoReadme({ repository, refName, family }: { repository: string; refName: string; family: RepoRouteFamily }) {
  const readme = useRepoReadme(repository, refName);
  const path = readme.data?.path ?? "README.md";
  const components = useMemo<Components>(() => ({
    ...MD_COMPONENTS,
    a: ({ href, children }: any) => {
      const url = resolveRepoMarkdownUrl(href ?? "", repository, refName, path, family);
      return url ? <Link href={url} className="text-sol-blue hover:underline">{children}</Link> : <span>{children}</span>;
    },
    img: ({ src, alt, width, height }: ImageProps) => {
      const url = resolveRepoMarkdownUrl(src ?? "", repository, refName, path, family, true);
      if (!url) return <span>{alt}</span>;
      return /^https?:/i.test(url) ? <img src={url} alt={alt ?? ""} width={width} height={height} loading="lazy" className="inline-block max-w-full h-auto" />
        : <RepoImage repository={repository} refName={refName} path={url} alt={alt} width={width} height={height} />;
    },
    code: ({ children, ...props }: any) => <code {...props}>{children}</code>,
    h1: alignedHeading("h1", "text-2xl font-serif mt-0 mb-3 text-sol-text"),
    h2: alignedHeading("h2", "text-lg font-semibold mt-6 mb-2 text-sol-text"),
    h3: alignedHeading("h3", "text-sm font-semibold mt-4 mb-1 text-sol-text-muted"),
  }), [repository, refName, path, family]);
  if (readme.error) return <p className="p-4 text-sol-text-muted text-xs">README could not be loaded.</p>;
  if (!readme.data?.found) return null;
  return <section className="border border-sol-border/60 rounded-lg overflow-hidden">
    <div className="border-b border-sol-border/50 px-4 py-3 text-xs"><Link href={repoBlobHref(repository, refName, path, family)}>{path}</Link></div>
    <div className="prose prose-sm max-w-none p-6 text-sol-text repo-readme">
      <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={README_REHYPE_PLUGINS} components={components}>
        {readme.data.content ?? ""}
      </ReactMarkdown>
    </div>
  </section>;
}
