import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  );
}

function KeyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
    </svg>
  );
}

function HashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
    </svg>
  );
}

function CodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
    </svg>
  );
}

const SECURITY_FEATURES = [
  {
    icon: LockIcon,
    title: "Private by default",
    description: "Every conversation starts private. You explicitly choose what to share with teammates.",
    detail: "Default visibility: private",
    color: "amber",
  },
  {
    icon: EyeOffIcon,
    title: "Automatic secret redaction",
    description: "API keys, tokens, passwords, and credentials are automatically stripped before sync.",
    detail: "Pattern-based detection",
    color: "red",
  },
  {
    icon: KeyIcon,
    title: "End-to-end encryption",
    description: "Enable client-side AES-256-GCM encryption. Your data is encrypted before it leaves your machine.",
    detail: "Enterprise feature",
    color: "green",
  },
  {
    icon: HashIcon,
    title: "Path hashing",
    description: "Project paths are hashed to prevent directory structure from being exposed.",
    detail: "SHA-256 hashing",
    color: "blue",
  },
  {
    icon: EyeOffIcon,
    title: "Activity hiding",
    description: "Make yourself invisible. Hide your activity from team dashboards and stats.",
    detail: "Per-user toggle",
    color: "purple",
  },
  {
    icon: CodeIcon,
    title: "Open source",
    description: "The entire codebase is open source. Audit it yourself, run security scans, verify our claims.",
    detail: "MIT License",
    color: "stone",
  },
];

const NEVER_DO = [
  {
    title: "Train AI on your code",
    description: "Your conversations and code are never used to train AI models. Period.",
  },
  {
    title: "Sell your data",
    description: "We don't sell, share, or monetize your data. Our business model is subscriptions, not data.",
  },
  {
    title: "Access without permission",
    description: "No employee can view your sessions unless you explicitly grant support access.",
  },
  {
    title: "Store your encryption keys",
    description: "When E2E encryption is enabled, keys are generated and stored only on your devices.",
  },
];

const FAQ = [
  {
    q: "Do you see my code?",
    a: "Only if you enable code sharing. By default, we sync conversation metadata (titles, timestamps, tool names) but not the actual code content.",
  },
  {
    q: "Will you train AI on my data?",
    a: "No. Your data is never used for AI training. We use Anthropic's API for any AI features, and your data never goes to model training.",
  },
  {
    q: "Can I delete my data?",
    a: "Yes. You can delete individual conversations or your entire account. Deletion is permanent and complete.",
  },
  {
    q: "Who can see my sessions?",
    a: "Only you, by default. If you share a session with your team, only team members can see it. You can revoke access anytime.",
  },
  {
    q: "Is it open source?",
    a: "Yes. The CLI, web dashboard, and backend are all open source under the MIT license. You can audit every line of code.",
  },
  {
    q: "Can I self-host?",
    a: "Yes. Deploy the entire stack on your own infrastructure. We provide deployment guides and enterprise support.",
  },
];

export default function SecurityPage() {
  return (
    <main className="min-h-screen bg-stone-50 w-full">
      {/* Nav */}
      <nav className="border-b border-stone-200 bg-stone-50/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <Logo size="md" className="text-stone-900" />
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/features" className="text-stone-600 hover:text-stone-900 font-medium text-sm px-3 py-1.5 hidden sm:block">
              CLI
            </Link>
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
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-green-700 text-sm font-medium mb-6">
            <ShieldIcon className="w-4 h-4" />
            Security & Privacy
          </div>

          <h1 className="text-5xl md:text-6xl font-bold text-stone-900 leading-[1.1] tracking-tight mb-6">
            Security you can verify
          </h1>

          <p className="text-xl text-stone-600 leading-relaxed max-w-2xl mx-auto">
            Open source, privacy-first architecture designed for security-conscious teams.
            Audit our code, self-host if you want, keep your code yours.
          </p>
        </div>
      </section>

      {/* Data Flow */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <div className="bg-white rounded-2xl border border-stone-200 p-8 md:p-12">
          <h2 className="text-2xl font-bold text-stone-900 mb-2 text-center">How your data flows</h2>
          <p className="text-stone-500 text-center mb-10">Code stays local unless you explicitly share it</p>

          <div className="flex flex-col md:flex-row gap-6 md:gap-0 md:items-stretch">
            {/* Local Machine */}
            <div className="flex-1 bg-stone-50 rounded-xl border-2 border-stone-200 p-6">
              <div className="w-12 h-12 rounded-lg bg-amber-100 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="font-semibold text-stone-900 mb-2">Your Machine</h3>
              <p className="text-sm text-stone-500 mb-4">CLI daemon runs locally, watches conversation files</p>
              <div className="space-y-2 text-xs font-mono">
                <div className="flex items-center gap-2 text-stone-600">
                  <CheckIcon className="w-4 h-4 text-green-500" />
                  <span>Code stays here</span>
                </div>
                <div className="flex items-center gap-2 text-stone-600">
                  <CheckIcon className="w-4 h-4 text-green-500" />
                  <span>Secrets redacted</span>
                </div>
                <div className="flex items-center gap-2 text-stone-600">
                  <CheckIcon className="w-4 h-4 text-green-500" />
                  <span>E2E encryption</span>
                </div>
              </div>
            </div>

            {/* Arrow 1 */}
            <div className="hidden md:flex items-center justify-center px-2 text-stone-300">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </div>

            {/* Sync Layer */}
            <div className="flex-1 bg-stone-50 rounded-xl border-2 border-stone-200 p-6">
              <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </div>
              <h3 className="font-semibold text-stone-900 mb-2">Sync Layer</h3>
              <p className="text-sm text-stone-500 mb-4">TLS 1.3 encrypted transport to Convex backend</p>
              <div className="space-y-2 text-xs font-mono">
                <div className="flex items-center gap-2 text-stone-600">
                  <CheckIcon className="w-4 h-4 text-green-500" />
                  <span>TLS 1.3 in transit</span>
                </div>
                <div className="flex items-center gap-2 text-stone-600">
                  <CheckIcon className="w-4 h-4 text-green-500" />
                  <span>Metadata only*</span>
                </div>
                <div className="flex items-center gap-2 text-stone-600">
                  <CheckIcon className="w-4 h-4 text-green-500" />
                  <span>Paths hashed</span>
                </div>
              </div>
            </div>

            {/* Arrow 2 */}
            <div className="hidden md:flex items-center justify-center px-2 text-stone-300">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </div>

            {/* Storage */}
            <div className="flex-1 bg-stone-50 rounded-xl border-2 border-stone-200 p-6">
              <div className="w-12 h-12 rounded-lg bg-green-100 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                </svg>
              </div>
              <h3 className="font-semibold text-stone-900 mb-2">Storage</h3>
              <p className="text-sm text-stone-500 mb-4">Convex database with SOC 2 Type II compliance</p>
              <div className="space-y-2 text-xs font-mono">
                <div className="flex items-center gap-2 text-stone-600">
                  <CheckIcon className="w-4 h-4 text-green-500" />
                  <span>SOC 2 Type II</span>
                </div>
                <div className="flex items-center gap-2 text-stone-600">
                  <CheckIcon className="w-4 h-4 text-green-500" />
                  <span>Encrypted at rest</span>
                </div>
                <div className="flex items-center gap-2 text-stone-600">
                  <CheckIcon className="w-4 h-4 text-green-500" />
                  <span>Your data isolated</span>
                </div>
              </div>
            </div>
          </div>

          <p className="text-xs text-stone-400 text-center mt-6">
            * Full conversation content synced only if you enable it. Default: metadata only (titles, timestamps, tool names).
          </p>
        </div>
      </section>

      {/* Security Features */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-stone-900 mb-4">Security features</h2>
          <p className="text-lg text-stone-500">Built for teams that take security seriously</p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {SECURITY_FEATURES.map((feature) => (
            <div key={feature.title} className="bg-white rounded-xl border border-stone-200 p-6">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-4 ${
                feature.color === "amber" ? "bg-amber-100" :
                feature.color === "red" ? "bg-red-100" :
                feature.color === "green" ? "bg-green-100" :
                feature.color === "blue" ? "bg-blue-100" :
                feature.color === "purple" ? "bg-purple-100" :
                "bg-stone-100"
              }`}>
                <feature.icon className={`w-5 h-5 ${
                  feature.color === "amber" ? "text-amber-600" :
                  feature.color === "red" ? "text-red-600" :
                  feature.color === "green" ? "text-green-600" :
                  feature.color === "blue" ? "text-blue-600" :
                  feature.color === "purple" ? "text-purple-600" :
                  "text-stone-600"
                }`} />
              </div>
              <h3 className="font-semibold text-stone-900 mb-2">{feature.title}</h3>
              <p className="text-sm text-stone-500 mb-3">{feature.description}</p>
              <span className="text-xs font-mono text-stone-400 bg-stone-50 px-2 py-1 rounded">
                {feature.detail}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* What We Never Do */}
      <section className="bg-stone-900 text-white py-20">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">What we never do</h2>
            <p className="text-lg text-stone-400">Commitments we make to every user</p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {NEVER_DO.map((item) => (
              <div key={item.title} className="flex gap-4">
                <div className="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center shrink-0">
                  <XIcon className="w-5 h-5 text-red-400" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg mb-1">{item.title}</h3>
                  <p className="text-stone-400">{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Technical Details */}
      <section className="max-w-4xl mx-auto px-6 py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-stone-900 mb-4">Technical details</h2>
          <p className="text-lg text-stone-500">For security teams and auditors</p>
        </div>

        <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
          <div className="grid md:grid-cols-2">
            <div className="p-8 border-b md:border-b-0 md:border-r border-stone-200">
              <h3 className="font-semibold text-stone-900 mb-4">Encryption</h3>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-stone-400 font-mono text-xs">Algorithm</dt>
                  <dd className="text-stone-700">AES-256-GCM</dd>
                </div>
                <div>
                  <dt className="text-stone-400 font-mono text-xs">IV</dt>
                  <dd className="text-stone-700">Random 12-byte per encryption</dd>
                </div>
                <div>
                  <dt className="text-stone-400 font-mono text-xs">Key derivation</dt>
                  <dd className="text-stone-700">HMAC-SHA512, BIP32-style hierarchy</dd>
                </div>
                <div>
                  <dt className="text-stone-400 font-mono text-xs">Key size</dt>
                  <dd className="text-stone-700">256-bit (32 bytes)</dd>
                </div>
              </dl>
            </div>
            <div className="p-8">
              <h3 className="font-semibold text-stone-900 mb-4">Infrastructure</h3>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-stone-400 font-mono text-xs">Transport</dt>
                  <dd className="text-stone-700">TLS 1.3</dd>
                </div>
                <div>
                  <dt className="text-stone-400 font-mono text-xs">Backend</dt>
                  <dd className="text-stone-700">Convex (SOC 2 Type II)</dd>
                </div>
                <div>
                  <dt className="text-stone-400 font-mono text-xs">Storage encryption</dt>
                  <dd className="text-stone-700">AES-256 at rest</dd>
                </div>
                <div>
                  <dt className="text-stone-400 font-mono text-xs">Auth</dt>
                  <dd className="text-stone-700">OAuth 2.0, GitHub/Google SSO</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="border-t border-stone-200 p-6 bg-stone-50">
            <p className="text-xs text-stone-500 font-mono mb-3">// Example: Client-side encryption flow</p>
            <pre className="text-xs text-stone-700 font-mono overflow-x-auto">
{`const masterKey = crypto.getRandomValues(new Uint8Array(32));
const sessionKey = await deriveKey(masterKey, 'messages', [sessionId]);
const encrypted = await encryptAESGCM(message, sessionKey);
// Server only sees encrypted blob, never the plaintext`}
            </pre>
          </div>
        </div>
      </section>

      {/* Self-Hosting */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="bg-gradient-to-br from-stone-100 to-stone-50 rounded-2xl border border-stone-200 p-12 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-sm font-medium mb-6">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
            Self-hostable
          </div>
          <h2 className="text-3xl font-bold text-stone-900 mb-4">Complete control</h2>
          <p className="text-lg text-stone-600 leading-relaxed mb-8 max-w-2xl mx-auto">
            Deploy the entire Codecast stack on your own infrastructure. Your data never leaves your network.
            We provide deployment guides and enterprise support for self-hosted installations.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a href="https://github.com/codecast-sh/codecast" target="_blank" rel="noopener noreferrer">
              <Button size="lg" className="bg-stone-900 text-white hover:bg-stone-800 font-medium">
                View on GitHub
              </Button>
            </a>
            <a href="mailto:enterprise@codecast.sh">
              <Button size="lg" variant="outline" className="border-stone-300 text-stone-700 hover:bg-stone-100 font-medium">
                Contact for enterprise
              </Button>
            </a>
          </div>
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

      {/* Security Contact */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="bg-stone-900 rounded-2xl p-12 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Security contact</h2>
          <p className="text-lg text-stone-400 mb-6 max-w-xl mx-auto">
            Found a vulnerability? We appreciate responsible disclosure and will work with you to address it quickly.
          </p>
          <a href="mailto:security@codecast.sh" className="inline-flex items-center gap-2 text-amber-400 hover:text-amber-300 font-mono text-lg">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            security@codecast.sh
          </a>
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
                <li><Link href="/features" className="hover:text-stone-900">CLI</Link></li>
                <li><Link href="/security" className="hover:text-stone-900">Security</Link></li>
                <li><Link href="/pricing" className="hover:text-stone-900">Pricing</Link></li>
                <li><Link href="/docs" className="hover:text-stone-900">Documentation</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-stone-900 mb-3 text-sm">Company</h4>
              <ul className="space-y-2 text-sm text-stone-500">
                <li><Link href="/about" className="hover:text-stone-900">About</Link></li>
                <li><Link href="/blog" className="hover:text-stone-900">Blog</Link></li>
                <li><Link href="/privacy" className="hover:text-stone-900">Privacy</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-stone-900 mb-3 text-sm">Connect</h4>
              <ul className="space-y-2 text-sm text-stone-500">
                <li><a href="https://github.com/codecast-sh" className="hover:text-stone-900" target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><a href="https://x.com/codecastsh" className="hover:text-stone-900" target="_blank" rel="noopener noreferrer">Twitter</a></li>
                <li><a href="https://discord.gg/codecast" className="hover:text-stone-900" target="_blank" rel="noopener noreferrer">Discord</a></li>
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
