import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";

export default function PrivacyPage() {
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

      {/* Content */}
      <article className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold text-stone-900 mb-4">Privacy Policy</h1>
        <p className="text-stone-500 mb-12">Last updated: January 14, 2025</p>

        <div className="prose prose-stone max-w-none">
          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">Overview</h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              Codecast (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our service.
            </p>
            <p className="text-stone-600 leading-relaxed">
              Codecast is a tool for syncing and managing AI coding conversations across devices and teams. We are designed with privacy as a core principle.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">Information We Collect</h2>

            <h3 className="text-lg font-semibold text-stone-800 mb-3">Account Information</h3>
            <p className="text-stone-600 leading-relaxed mb-4">
              When you create an account, we collect your email address and authentication credentials (via GitHub or Google OAuth). This information is used solely for account management and authentication.
            </p>

            <h3 className="text-lg font-semibold text-stone-800 mb-3">Conversation Data</h3>
            <p className="text-stone-600 leading-relaxed mb-4">
              By default, Codecast syncs conversation metadata only (titles, timestamps, tool usage). The actual content of your AI conversations is stored locally on your device unless you explicitly enable content sync.
            </p>
            <ul className="list-disc pl-6 text-stone-600 mb-4 space-y-2">
              <li><strong>Metadata (default):</strong> Session titles, timestamps, project identifiers (hashed), tool names</li>
              <li><strong>Content (opt-in):</strong> Full conversation messages and code snippets</li>
            </ul>

            <h3 className="text-lg font-semibold text-stone-800 mb-3">Usage Data</h3>
            <p className="text-stone-600 leading-relaxed">
              We collect basic usage statistics to improve our service, including feature usage patterns and error reports. This data is anonymized and cannot be used to identify individual users.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">How We Use Your Information</h2>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li>To provide and maintain our service</li>
              <li>To authenticate your account and manage sessions</li>
              <li>To sync your conversation data across devices (based on your settings)</li>
              <li>To enable team collaboration features when you share conversations</li>
              <li>To improve our service through anonymized analytics</li>
              <li>To communicate important updates about the service</li>
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">What We Do NOT Do</h2>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li><strong>No AI Training:</strong> Your data is never used to train AI models</li>
              <li><strong>No Data Selling:</strong> We never sell, rent, or trade your personal information</li>
              <li><strong>No Advertising:</strong> We do not use your data for advertising purposes</li>
              <li><strong>No Unauthorized Access:</strong> Employees cannot access your data without explicit permission</li>
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">Data Security</h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              We implement industry-standard security measures to protect your data:
            </p>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li>TLS 1.3 encryption for all data in transit</li>
              <li>AES-256 encryption for data at rest</li>
              <li>Optional client-side end-to-end encryption (AES-256-GCM)</li>
              <li>Automatic secret redaction (API keys, tokens, passwords)</li>
              <li>SOC 2 Type II compliant infrastructure (Convex)</li>
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">Data Retention</h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              We retain your data for as long as your account is active. You can delete individual conversations at any time. If you delete your account, all associated data is permanently removed within 30 days.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">Your Rights</h2>
            <p className="text-stone-600 leading-relaxed mb-4">You have the right to:</p>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li>Access your personal data</li>
              <li>Export your data in a portable format</li>
              <li>Delete your data and account</li>
              <li>Opt out of optional data collection</li>
              <li>Update your account information</li>
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">Third-Party Services</h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              We use the following third-party services:
            </p>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li><strong>Convex:</strong> Database and backend infrastructure</li>
              <li><strong>GitHub/Google:</strong> OAuth authentication</li>
              <li><strong>Vercel:</strong> Web hosting</li>
            </ul>
            <p className="text-stone-600 leading-relaxed mt-4">
              These services have their own privacy policies and we encourage you to review them.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">Children&apos;s Privacy</h2>
            <p className="text-stone-600 leading-relaxed">
              Codecast is not intended for children under 13 years of age. We do not knowingly collect personal information from children under 13.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">Changes to This Policy</h2>
            <p className="text-stone-600 leading-relaxed">
              We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the &quot;Last updated&quot; date.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">Contact Us</h2>
            <p className="text-stone-600 leading-relaxed">
              If you have any questions about this Privacy Policy, please contact us at{" "}
              <a href="mailto:privacy@codecast.sh" className="text-amber-600 hover:text-amber-700 font-medium">
                privacy@codecast.sh
              </a>
            </p>
          </section>
        </div>
      </article>

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
