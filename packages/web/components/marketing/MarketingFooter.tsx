import Link from "next/link";
import { Logo } from "@/components/Logo";
import { SITE_LINKS } from "@/lib/siteLinks";

export function MarketingFooter() {
  return (
    <footer className="border-t border-[#eee8d5] bg-[#fdf6e3] text-[#657b83]">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid md:grid-cols-4 gap-8">
          <div>
            <Link href="/" aria-label="Codecast home" className="inline-block mb-4">
              <Logo size="md" className="[--logo-c:#444444] text-[#002b36]" />
            </Link>
            <p className="text-sm">Watch, steer, and search every agent session.</p>
          </div>
          <div>
            <h2 className="font-semibold text-[#002b36] mb-3 text-sm">Product</h2>
            <ul className="space-y-2 text-sm">
              <li><a href="/#how-it-works" className="hover:text-[#073642]">How it works</a></li>
              <li><Link href="/documentation" className="hover:text-[#073642]">Documentation</Link></li>
              <li><Link href="/features" className="hover:text-[#073642]">CLI</Link></li>
              <li><Link href="/changelog" className="hover:text-[#073642]">Changelog</Link></li>
              <li><Link href="/pricing" className="hover:text-[#073642]">Pricing</Link></li>
              <li><Link href="/compare" className="hover:text-[#073642]">Compare</Link></li>
              <li><Link href="/security" className="hover:text-[#073642]">Security</Link></li>
              <li><Link href="/download" className="hover:text-[#073642]">Desktop App</Link></li>
              <li><a href={SITE_LINKS.appStore} target="_blank" rel="noopener noreferrer" className="hover:text-[#073642]">iOS App</a></li>
              <li><a href={SITE_LINKS.chromeExtension} target="_blank" rel="noopener noreferrer" className="hover:text-[#073642]">Chrome Extension</a></li>
            </ul>
          </div>
          <div>
            <h2 className="font-semibold text-[#002b36] mb-3 text-sm">Company</h2>
            <ul className="space-y-2 text-sm">
              <li><Link href="/about" className="hover:text-[#073642]">About</Link></li>
              <li><Link href="/blog" className="hover:text-[#073642]">Blog</Link></li>
              <li><Link href="/privacy" className="hover:text-[#073642]">Privacy</Link></li>
              <li><Link href="/terms" className="hover:text-[#073642]">Terms</Link></li>
              <li><Link href="/support" className="hover:text-[#073642]">Support</Link></li>
            </ul>
          </div>
          <div>
            <h2 className="font-semibold text-[#002b36] mb-3 text-sm">Connect</h2>
            <ul className="space-y-2 text-sm">
              <li><a href={SITE_LINKS.githubRepo} className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">GitHub</a></li>
              <li><a href={SITE_LINKS.x} className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Twitter</a></li>
              <li><Link href={SITE_LINKS.community} className="hover:text-[#073642]">Community</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-[#eee8d5] mt-8 pt-8 text-center text-sm text-[#839496]">
          &copy; {new Date().getFullYear()} Codecast
        </div>
      </div>
    </footer>
  );
}
