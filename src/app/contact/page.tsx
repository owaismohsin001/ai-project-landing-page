import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { ContactForm } from "./ContactForm";

export const metadata = {
  title: "Contact sales — Enterprise",
};

export default function ContactPage() {
  return (
    <>
      <Navbar />
      <main className="glow mx-auto max-w-2xl px-6 py-20">
        <div className="text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-500/40 bg-brand-500/10 px-4 py-1.5 text-xs font-medium text-brand-700 dark:border-brand-500/30 dark:text-brand-300">
            Enterprise
          </span>
          <h1 className="mt-5 text-3xl font-bold text-slate-900 sm:text-4xl dark:text-white">
            Talk to our sales team
          </h1>
          <p className="mt-3 text-slate-600 dark:text-slate-300">
            Tell us about your organization and we&apos;ll put together an
            Enterprise plan that fits — custom limits, SLAs, and security.
          </p>
        </div>

        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm shadow-slate-900/[0.04] dark:border-white/10 dark:bg-ink-800 dark:shadow-none">
          <ContactForm />
        </div>
      </main>
      <Footer />
    </>
  );
}
