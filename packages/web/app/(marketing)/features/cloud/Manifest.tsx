"use client";

import { SOL } from "../../blog/blogChrome";
import { C, Caption } from "./kit";

/** What the host receives from the laptop, how, and the line it will not cross. From the cloud guide's table. */
const ROWS: { what: string; items: string; how: string; never: string }[] = [
  {
    what: "Instructions and agent config",
    items: ".claude, .codex, .gemini, .grok, .opencode, .agents, repo instruction files, git preferences, your codecast switches",
    how: "Home mirror, written atomically with mode 0600. Rescans a minute after each pass; bytes re-verified every 30 minutes.",
    never: "Credentials, transcripts, databases, caches, media, native binaries. Never wakes a sleeping host.",
  },
  {
    what: "Shell",
    items: ".bashrc, .zshrc, fish config, .inputrc, .tmux.conf and every file they source",
    how: "Home mirror, with laptop paths rewritten to the host's. A login shell there also gets CODECAST_CLOUD=1.",
    never: "Exports travel as written, keys included, so keep secrets out of rc files you do not want on the host.",
  },
  {
    what: "Agent logins",
    items: "Claude, Codex, Grok, Gemini, opencode, pi, provider keys",
    how: "One bundle over SSH stdin. Each file ships only while its token is live.",
    never: "Never through codecast's servers. ANTHROPIC_API_KEY never travels. A bundle for a different user is refused whole.",
  },
  {
    what: "Tool logins",
    items: "gh, cf and wrangler, Convex, AWS, gcloud, Vercel, Railway, Fly, Netlify, Supabase, Stripe, Expo, kubeconfig, npm, .netrc",
    how: "Login bundle over SSH stdin, macOS config paths mapped to Linux ones.",
    never: "An OAuth login that rotates on refresh ships only while its access token is live.",
  },
  {
    what: "CLIs",
    items: "claude, codex, gemini, grok, opencode, pi, plus vercel, railway, cf, supabase, stripe, fly, aws, gcloud, kubectl if your shell has them",
    how: "Installed when missing, at your laptop's versions and local to the user, while a session is prepared, at setup, and when you press Wake in Settings, Devices. A wake for queued work only checks them.",
    never: "No sudo, no system packages: those go in the [host] table. What is missing shows on the host's Tools row.",
  },
  {
    what: "Agent memory",
    items: "Memories a cloud session wrote or edited",
    how: "Both ways: the laptop brings host memories home before it sends the merged set back.",
    never: "MEMORY.md only gains index lines the laptop does not have yet.",
  },
  {
    what: "Browser logins",
    items: "One site's cookies, on request",
    how: "On the host, cast browser sync <site> asks your online laptop to inject them over an SSH forward.",
    never: "Google is never carried. A request no laptop picks up expires in 5 minutes.",
  },
];

export function ManifestSection() {
  return (
    <>
      <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "#0b4a5a", backgroundColor: "#01232c" }}>
        <div className="hidden md:grid grid-cols-[1.05fr_1.5fr_1.4fr_1.4fr] gap-6 px-6 py-3 font-mono text-[11.5px] border-b" style={{ color: SOL.base01, borderColor: "#0b4a5a", backgroundColor: SOL.base02 }}>
          <span>what</span><span>includes</span><span>how it travels</span><span>where it stops</span>
        </div>
        <ul>
          {ROWS.map((r, i) => (
            <li
              key={r.what}
              className="cl-row grid md:grid-cols-[1.05fr_1.5fr_1.4fr_1.4fr] gap-x-6 gap-y-2 px-6 py-5"
              style={{ borderTop: i ? "1px solid #0b3c48" : undefined }}
            >
              <span className="font-mono font-semibold text-[14px]" style={{ color: SOL.base2 }}>{r.what}</span>
              <span className="font-mono text-[12px] leading-6" style={{ color: SOL.base0 }}>{r.items}</span>
              <span className="text-[14px] leading-6" style={{ color: SOL.base1 }}>
                <span className="md:hidden font-mono text-[11px] mr-2" style={{ color: SOL.cyan }}>how</span>{r.how}
              </span>
              <span className="text-[14px] leading-6 pl-3 border-l-2" style={{ color: SOL.base1, borderColor: "rgba(220,50,47,.55)" }}>
                <span className="md:hidden font-mono text-[11px] mr-2" style={{ color: SOL.red }}>stops</span>{r.never}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <Caption dark>
        <span style={{ color: SOL.base1 }}>
          The host&apos;s card in Settings, Devices shows whether your setup, logins and tools are in step. From a terminal: <C dark>cast hosts sync --dry-run</C> previews the mirror, <C dark>cast hosts tools</C> installs missing tools now, and <C dark>cast config cloud_mirror_enabled false</C> turns the mirror off. A running agent keeps the instructions it read at startup.
        </span>
      </Caption>
    </>
  );
}
