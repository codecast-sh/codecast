import { useMemo } from "react";
import Link from "next/link";
import { MarkdownBlocks } from "../tools/MarkdownRenderer";
import { MD_COMPONENTS } from "../../lib/markdownComponents";
import { resolveRepoMarkdownUrl } from "../../lib/repoContent";
import { useRepoBlob, useRepoReadme } from "../../hooks/useRepoBrowse";
import { repoBlobHref, type RepoRouteFamily } from "../../lib/repoView";

function RepoImage({ repository, refName, path, alt }: { repository: string; refName: string; path: string; alt?: string }) {
  const blob = useRepoBlob(repository, refName, path);
  const content = blob.data;
  if (!content || content.truncated) return <span className="text-sol-text-dim">{alt || path}</span>;
  const mime = path.endsWith(".svg") ? "image/svg+xml" : path.match(/\.jpe?g$/i) ? "image/jpeg" : `image/${path.split(".").pop()}`;
  const src = content.base64 ? `data:${mime};base64,${content.base64}` : `data:${mime};charset=utf-8,${encodeURIComponent(content.content)}`;
  return <img src={src} alt={alt ?? ""} className="max-w-full h-auto" loading="lazy" />;
}

export function RepoReadme({ repository, refName, family }: { repository: string; refName: string; family: RepoRouteFamily }) {
  const readme = useRepoReadme(repository, refName);
  const path = readme.data?.path ?? "README.md";
  const components = useMemo(() => ({
    ...MD_COMPONENTS,
    a: ({ href, children }: any) => {
      const url = resolveRepoMarkdownUrl(href ?? "", repository, refName, path, family);
      return url ? <Link href={url} className="text-sol-blue hover:underline">{children}</Link> : <span>{children}</span>;
    },
    img: ({ src, alt }: any) => {
      const url = resolveRepoMarkdownUrl(src ?? "", repository, refName, path, family, true);
      if (!url) return <span>{alt}</span>;
      return /^https?:/i.test(url) ? <img src={url} alt={alt ?? ""} loading="lazy" className="max-w-full h-auto" />
        : <RepoImage repository={repository} refName={refName} path={url} alt={alt} />;
    },
    code: ({ children, ...props }: any) => <code {...props}>{children}</code>,
  }), [repository, refName, path, family]);
  if (readme.error) return <p className="p-4 text-sol-text-muted text-xs">README could not be loaded.</p>;
  if (!readme.data?.found) return null;
  return <section className="border border-sol-border/60 rounded-lg overflow-hidden">
    <div className="border-b border-sol-border/50 px-4 py-3 text-xs"><Link href={repoBlobHref(repository, refName, path, family)}>{path}</Link></div>
    <div className="prose prose-sm max-w-none p-6 text-sol-text"><MarkdownBlocks content={readme.data.content ?? ""} components={components} /></div>
  </section>;
}
