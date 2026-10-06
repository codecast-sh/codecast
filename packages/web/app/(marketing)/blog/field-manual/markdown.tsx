"use client";

import Link from "next/link";
import { Children, isValidElement, type AnchorHTMLAttributes, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Cmd, Code, Figure, H2, P, SOL, Terminal } from "../blogChrome";

/** The anchor id of a section heading; the chapter rail links to the same ids. */
export function sectionId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** The chapter's `## ` headings, in order, for the rail. */
export function chapterSections(md: string): { id: string; title: string }[] {
  return [...md.matchAll(/^## (.+)$/gm)].map((m) => {
    const title = m[1].replace(/`/g, "");
    return { id: sectionId(title), title };
  });
}

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((c) => (typeof c === "string" ? c : isValidElement<{ children?: ReactNode }>(c) ? plainText(c.props.children) : ""))
    .join("");
}

function MdLink({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const style = { color: SOL.blue };
  if (href?.startsWith("/")) {
    return <Link href={href} className="underline underline-offset-2" style={style}>{children}</Link>;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={style}>{children}</a>;
}

type ImgProps = { src?: string; alt?: string; title?: string };

/** A caption arrives as the image's plain-text title; its `code` spans still render as code. */
function Caption({ text }: { text?: string }) {
  return <>{(text ?? "").split(/`([^`]+)`/).map((part, i) => (i % 2 ? <Code key={i}>{part}</Code> : part))}</>;
}

/** A screenshot: breaks out of the text column, opens full size on click, caption from the markdown title. */
function Shot({ src, alt, title }: ImgProps) {
  return (
    <Figure caption={<Caption text={title} />} wide>
      <a href={src} target="_blank" rel="noopener noreferrer" className="block cursor-zoom-in">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt ?? ""} className="w-full block" loading="lazy" />
      </a>
    </Figure>
  );
}

// A paragraph holding only images is a figure (one) or a side by side pair.
function isImageOnly(children: ReactNode): ImgProps[] | null {
  const kids = Children.toArray(children).filter((c) => !(typeof c === "string" && !c.trim()));
  if (!kids.length) return null;
  const imgs = kids.map((c) => (isValidElement<ImgProps>(c) && c.props.src ? c.props : null));
  return imgs.every(Boolean) ? (imgs as ImgProps[]) : null;
}

/** Terminal blocks: `$ ` lines render as commands, the rest as output. */
function TerminalBlock({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <Terminal label="terminal">
      {lines.map((line, i) =>
        line.startsWith("$ ") ? <Cmd key={i}>{line.slice(2)}</Cmd> : <span key={i}>{line}{"\n"}</span>,
      )}
    </Terminal>
  );
}

export function ChapterMarkdown({ source, accent }: { source: string; accent: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: ({ children }) => (
          <div id={sectionId(plainText(children))} style={{ scrollMarginTop: "6rem" }}>
            <H2>{children}</H2>
          </div>
        ),
        h3: ({ children }) => (
          <h3 className="text-lg font-bold font-mono tracking-tight mt-9 mb-3" style={{ color: SOL.base02 }}>{children}</h3>
        ),
        p: ({ children }) => {
          const imgs = isImageOnly(children);
          if (!imgs) return <P>{children}</P>;
          if (imgs.length === 1) return <Shot {...imgs[0]} />;
          return (
            <div className="grid md:grid-cols-2 gap-5 md:-mx-20">
              {imgs.map((img) => (
                <Figure key={img.src} caption={<Caption text={img.title} />}>
                  <a href={img.src} target="_blank" rel="noopener noreferrer" className="block cursor-zoom-in">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.src} alt={img.alt ?? ""} className="w-full block" loading="lazy" />
                  </a>
                </Figure>
              ))}
            </div>
          );
        },
        img: (props) => <Shot {...props} />,
        a: MdLink,
        strong: ({ children }) => <strong className="font-semibold" style={{ color: SOL.base02 }}>{children}</strong>,
        ul: ({ children }) => <ul className="list-disc pl-5 mb-6 space-y-2 text-[17px] leading-8" style={{ color: SOL.base01 }}>{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 mb-6 space-y-2 text-[17px] leading-8" style={{ color: SOL.base01 }}>{children}</ol>,
        code: ({ className, children }) => {
          const text = String(children ?? "");
          if (className?.includes("language-") || text.includes("\n")) return <code>{children}</code>;
          return <Code>{children}</Code>;
        },
        pre: ({ children }) => {
          const code = Children.toArray(children)[0];
          const text = isValidElement<{ children?: ReactNode }>(code) ? String(code.props.children ?? "") : "";
          return <TerminalBlock text={text} />;
        },
        blockquote: ({ children }) => (
          <aside
            className="my-8 rounded-xl px-6 pt-5 pb-1 [&_p]:text-[16px] [&_p]:leading-7"
            style={{ backgroundColor: `color-mix(in srgb, ${accent} 9%, ${SOL.base3})`, border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)` }}
          >
            {children}
          </aside>
        ),
        table: ({ children }) => (
          <div className="my-8 md:-mx-20 overflow-x-auto rounded-xl border" style={{ borderColor: SOL.base2 }}>
            <table className="w-full text-[14px] leading-6" style={{ borderCollapse: "collapse" }}>{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th
            className="text-left font-mono font-semibold px-4 py-3 text-[13px] align-bottom"
            style={{ color: SOL.base03, backgroundColor: `color-mix(in srgb, ${accent} 10%, ${SOL.base3})`, borderBottom: `2px solid ${accent}` }}
          >
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-4 py-3 align-top" style={{ color: SOL.base01, borderTop: `1px solid ${SOL.base2}` }}>{children}</td>
        ),
      }}
    >
      {source}
    </ReactMarkdown>
  );
}
