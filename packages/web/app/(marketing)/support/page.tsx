import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";

function MailIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

function BookIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
    </svg>
  );
}

const SUPPORT_OPTIONS = [
  {
    icon: MailIcon,
    title: "Email Support",
    description: "Get help from our team via email. We typically respond within 24 hours.",
    action: "support@codecast.sh",
    href: "mailto:support@codecast.sh",
    color: "amber",
  },
  {
    icon: GithubIcon,
    title: "GitHub Issues",
    description: "Report bugs, request features, or browse existing issues on GitHub.",
    action: "Open an issue",
    href: "https://github.com/ashot/codecast/issues",
    color: "stone",
  },
  {
    icon: BookIcon,
    title: "Documentation",
    description: "Browse our guides, tutorials, and API documentation.",
    action: "View docs",
    href: "https://github.com/ashot/codecast#readme",
    color: "blue",
  },
];

const FAQ = [
  {
    q: "How do I install the CLI?",
    a: "Run `npm install -g @codecast/cli` or `brew install codecast` to install the CLI globally.",
  },
  {
    q: "How do I sync my conversations?",
    a: "After installing, run `codecast login` to authenticate, then `codecast sync` to start syncing your AI conversations.",
  },
  {
    q: "Can I use Codecast offline?",
    a: "Yes! Conversations are stored locally and synced when you're online. The CLI works fully offline.",
  },
  {
    q: "How do I share a conversation with my team?",
    a: "Open the conversation in the web dashboard and click 'Share'. You can share with specific team members or generate a public link.",
  },
  {
    q: "How do I delete my data?",
    a: "You can delete individual conversations from the dashboard, or delete your entire account from Settings > Account > Delete Account.",
  },
  {
    q: "Is my code visible to Codecast?",
    a: "By default, only metadata is synced. Code content sync is opt-in. You can also enable end-to-end encryption for additional privacy.",
  },
];

export default function SupportPage() {
  return (
    <main className="min-h-screen bg-stone-50 w-full">
      {/* Nav */}
      <nav className="border-b border-stone-200 bg-stone-50/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <Logo size="md" className="text-stone-900" />
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/security" className="text-stone-600 hover:text-stone-900 font-medium text-sm px-3 py-1.5">
              Security
            </Link>
            <Link href="/login">
              <Button variant="ghost" className="text-stone-600 hover:text-stone-900 hover:bg-stone-100 font-medium">
                Sign in
              </Button>
            </Link>
            <Link href="/signup">
              <Button className="bg-stone-900 text-white hover:bg-stone-800 font-medium">
                Get started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-20 pb-16">
        <div className="text-center max-w-3xl mx-auto">
          <h1 className="text-5xl font-bold text-stone-900 leading-[1.1] tracking-tight mb-6">
            How can we help?
          </h1>
          <p className="text-xl text-stone-600 leading-relaxed">
            Get support, browse documentation, or reach out to our team.
          </p>
        </div>
      </section>

      {/* Support Options */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="grid md:grid-cols-3 gap-6">
          {SUPPORT_OPTIONS.map((option) => (
            <a
              key={option.title}
              href={option.href}
              target={option.href.startsWith("http") ? "_blank" : undefined}
              rel={option.href.startsWith("http") ? "noopener noreferrer" : undefined}
              className="bg-white rounded-xl border border-stone-200 p-6 hover:border-stone-300 hover:shadow-sm transition-all"
            >
              <div className={`w-12 h-12 rounded-lg flex items-center justify-center mb-4 ${
                option.color === "amber" ? "bg-amber-100" :
                option.color === "blue" ? "bg-blue-100" :
                "bg-stone-100"
              }`}>
                <option.icon className={`w-6 h-6 ${
                  option.color === "amber" ? "text-amber-600" :
                  option.color === "blue" ? "text-blue-600" :
                  "text-stone-600"
                }`} />
              </div>
              <h3 className="font-semibold text-stone-900 mb-2">{option.title}</h3>
              <p className="text-sm text-stone-500 mb-4">{option.description}</p>
              <span className="text-sm font-medium text-amber-600">
                {option.action} &rarr;
              </span>
            </a>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-3xl mx-auto px-6 pb-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-stone-900 mb-4">Frequently asked questions</h2>
        </div>

        <div className="space-y-4">
          {FAQ.map((item) => (
            <div key={item.q} className="bg-white rounded-xl border border-stone-200 p-6">
              <h3 className="font-semibold text-stone-900 mb-2">{item.q}</h3>
              <p className="text-stone-600">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-stone-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <Logo size="md" className="text-stone-900 mb-4" />
              <p className="text-sm text-stone-500">
                Real-time sync for AI coding sessions.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-stone-900 mb-3 text-sm">Product</h4>
              <ul className="space-y-2 text-sm text-stone-500">
                <li><Link href="/#how-it-works" className="hover:text-stone-900">How it works</Link></li>
                <li><Link href="/security" className="hover:text-stone-900">Security</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-stone-900 mb-3 text-sm">Legal</h4>
              <ul className="space-y-2 text-sm text-stone-500">
                <li><Link href="/privacy" className="hover:text-stone-900">Privacy Policy</Link></li>
                <li><Link href="/terms" className="hover:text-stone-900">Terms of Service</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-stone-900 mb-3 text-sm">Connect</h4>
              <ul className="space-y-2 text-sm text-stone-500">
                <li><a href="https://github.com/ashot" className="hover:text-stone-900" target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><a href="mailto:support@codecast.sh" className="hover:text-stone-900">Support</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-stone-200 mt-8 pt-8 text-center text-sm text-stone-400">
            &copy; 2025 Codecast
          </div>
        </div>
      </footer>
    </main>
  );
}
