import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";

export default function AboutPage() {
  return (
    <main className="min-h-screen w-full" style={{ backgroundColor: '#fdf6e3' }}>
      <nav className="border-b border-[#eee8d5] bg-[#fdf6e3]/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <Logo size="md" className="text-[#002b36]" />
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/security" className="text-[#657b83] hover:text-[#002b36] font-medium text-sm px-3 py-1.5">
              Security
            </Link>
            <Link href="/login">
              <Button variant="ghost" className="text-[#657b83] hover:text-[#002b36] hover:bg-[#eee8d5] font-medium">
                Sign in
              </Button>
            </Link>
            <Link href="/signup">
              <Button className="bg-[#002b36] text-[#fdf6e3] hover:bg-[#073642] font-medium">
                Get started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 py-20">
        <h1 className="text-4xl font-bold text-[#002b36] mb-8 tracking-tight" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
          About Codecast
        </h1>

        <div className="space-y-6 text-[#586e75] text-lg leading-relaxed" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
          <p>
            Codecast was built by an engineer who spent years watching the gap between what AI coding agents could do and what teams could actually learn from them.
          </p>

          <p>
            The problem was simple: AI agents generate enormous amounts of context -- decisions, debugging traces, architectural reasoning -- and all of it vanishes the moment a session ends. Teams were building with the most powerful tools ever created, and had nothing to show for it but the final commit.
          </p>

          <p>
            Codecast exists to capture that missing layer. Every agent session, every debugging rabbit hole, every architectural decision gets synced, indexed, and made searchable across your team. Not as surveillance, but as institutional memory -- the kind that lets a teammate pick up exactly where you left off, or lets your future self understand why a decision was made six months ago.
          </p>

          <p>
            We believe the best engineering teams will be the ones that compound their AI-assisted work into shared knowledge, rather than letting it evaporate session by session.
          </p>

          <p>
            Codecast is independent, self-funded, and built in San Francisco.
          </p>
        </div>
      </div>

      <footer className="border-t border-[#eee8d5]" style={{ backgroundColor: '#fdf6e3' }}>
        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <Logo size="md" className="text-[#002b36] mb-4" />
              <p className="text-sm text-[#657b83]">
                Real-time sync for Claude Code, Codex, Gemini, and Cursor.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Product</h4>
              <ul className="space-y-2 text-sm text-[#657b83]">
                <li><Link href="/#how-it-works" className="hover:text-[#073642]">How it works</Link></li>
                <li><Link href="/features" className="hover:text-[#073642]">CLI</Link></li>
                <li><Link href="/security" className="hover:text-[#073642]">Security</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Company</h4>
              <ul className="space-y-2 text-sm text-[#657b83]">
                <li><Link href="/about" className="hover:text-[#073642]">About</Link></li>
                <li><Link href="/privacy" className="hover:text-[#073642]">Privacy</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Connect</h4>
              <ul className="space-y-2 text-sm text-[#657b83]">
                <li><a href="https://github.com/codecast-sh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><a href="https://x.com/codecastsh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Twitter</a></li>
                <li><a href="https://discord.gg/S7V5Wnfq" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Discord</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-[#eee8d5] mt-8 pt-8 text-center text-sm text-[#839496]">
            &copy; 2025 Codecast
          </div>
        </div>
      </footer>
    </main>
  );
}
