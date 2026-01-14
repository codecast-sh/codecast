import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";

export default function TermsPage() {
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
        <h1 className="text-4xl font-bold text-stone-900 mb-4">Terms of Service</h1>
        <p className="text-stone-500 mb-12">Last updated: January 14, 2025</p>

        <div className="prose prose-stone max-w-none">
          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">1. Agreement to Terms</h2>
            <p className="text-stone-600 leading-relaxed">
              By accessing or using Codecast (&quot;Service&quot;), you agree to be bound by these Terms of Service (&quot;Terms&quot;). If you disagree with any part of these terms, you may not access the Service.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">2. Description of Service</h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              Codecast provides tools for synchronizing, managing, and sharing AI coding conversations. The Service includes:
            </p>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li>A command-line interface (CLI) for syncing conversations</li>
              <li>A web dashboard for viewing and managing conversations</li>
              <li>Team collaboration features for sharing sessions</li>
              <li>Mobile applications for accessing conversations on the go</li>
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">3. User Accounts</h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              To use certain features of the Service, you must create an account. You are responsible for:
            </p>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li>Maintaining the confidentiality of your account credentials</li>
              <li>All activities that occur under your account</li>
              <li>Notifying us immediately of any unauthorized access</li>
              <li>Ensuring your account information is accurate and up-to-date</li>
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">4. Acceptable Use</h2>
            <p className="text-stone-600 leading-relaxed mb-4">You agree not to:</p>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li>Use the Service for any illegal purpose or in violation of any laws</li>
              <li>Attempt to gain unauthorized access to any part of the Service</li>
              <li>Interfere with or disrupt the Service or servers</li>
              <li>Upload malicious code or attempt to compromise the Service</li>
              <li>Use the Service to store or transmit infringing or illegal content</li>
              <li>Impersonate any person or entity</li>
              <li>Resell or redistribute the Service without authorization</li>
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">5. Your Content</h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              You retain all rights to the content you sync through Codecast. By using the Service, you grant us a limited license to:
            </p>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li>Store and process your content to provide the Service</li>
              <li>Display your content to you and users you share with</li>
              <li>Create backups for data protection purposes</li>
            </ul>
            <p className="text-stone-600 leading-relaxed mt-4">
              We do not claim ownership of your content and will never use it for purposes other than providing the Service.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">6. Privacy</h2>
            <p className="text-stone-600 leading-relaxed">
              Your use of the Service is also governed by our{" "}
              <Link href="/privacy" className="text-amber-600 hover:text-amber-700 font-medium">
                Privacy Policy
              </Link>
              , which describes how we collect, use, and protect your information.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">7. Intellectual Property</h2>
            <p className="text-stone-600 leading-relaxed">
              The Service and its original content (excluding content provided by users), features, and functionality are owned by Codecast and are protected by copyright, trademark, and other intellectual property laws. The Codecast CLI and related tools are open source under the MIT License.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">8. Subscriptions and Payments</h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              Some features of the Service require a paid subscription. For paid subscriptions:
            </p>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li>Payment is due at the beginning of each billing period</li>
              <li>Subscriptions automatically renew unless cancelled</li>
              <li>You may cancel your subscription at any time</li>
              <li>Refunds are provided in accordance with our refund policy</li>
              <li>Prices may change with 30 days notice</li>
            </ul>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">9. Service Availability</h2>
            <p className="text-stone-600 leading-relaxed">
              We strive to maintain high availability but do not guarantee uninterrupted access. The Service may be temporarily unavailable for maintenance, updates, or circumstances beyond our control. We will make reasonable efforts to notify you of planned downtime.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">10. Disclaimer of Warranties</h2>
            <p className="text-stone-600 leading-relaxed">
              THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR COMPLETELY SECURE.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">11. Limitation of Liability</h2>
            <p className="text-stone-600 leading-relaxed">
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, CODECAST SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES RESULTING FROM YOUR USE OF THE SERVICE.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">12. Indemnification</h2>
            <p className="text-stone-600 leading-relaxed">
              You agree to indemnify and hold harmless Codecast and its officers, directors, employees, and agents from any claims, damages, losses, or expenses arising from your use of the Service or violation of these Terms.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">13. Termination</h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              We may terminate or suspend your account and access to the Service immediately, without prior notice, for conduct that we believe:
            </p>
            <ul className="list-disc pl-6 text-stone-600 space-y-2">
              <li>Violates these Terms</li>
              <li>Is harmful to other users or third parties</li>
              <li>Is fraudulent or illegal</li>
            </ul>
            <p className="text-stone-600 leading-relaxed mt-4">
              Upon termination, your right to use the Service will immediately cease. You may delete your account at any time through your account settings.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">14. Changes to Terms</h2>
            <p className="text-stone-600 leading-relaxed">
              We reserve the right to modify these Terms at any time. We will provide notice of material changes by posting the updated Terms on this page and updating the &quot;Last updated&quot; date. Your continued use of the Service after changes constitutes acceptance of the new Terms.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">15. Governing Law</h2>
            <p className="text-stone-600 leading-relaxed">
              These Terms shall be governed by and construed in accordance with the laws of the United States, without regard to its conflict of law provisions.
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl font-semibold text-stone-900 mb-4">16. Contact Us</h2>
            <p className="text-stone-600 leading-relaxed">
              If you have any questions about these Terms, please contact us at{" "}
              <a href="mailto:legal@codecast.sh" className="text-amber-600 hover:text-amber-700 font-medium">
                legal@codecast.sh
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
