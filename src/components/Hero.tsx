import Link from "next/link";
import { APP_NAME } from "@/lib/config";

export function Hero() {
  return (
    <section className="glow relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-6 py-24 text-center sm:py-32">
        <span className="inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-4 py-1.5 text-xs font-medium text-brand-300">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
          Now in public release
        </span>

        <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-6xl">
          Build smarter with{" "}
          <span className="bg-gradient-to-r from-brand-400 to-brand-600 bg-clip-text text-transparent">
            {APP_NAME}
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-lg text-slate-300">
          The platform for shipping AI-powered products — fast, reliable, and
          ready to scale from your first request to your millionth.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/#pricing"
            className="rounded-lg bg-brand-600 px-6 py-3 font-medium text-white transition hover:bg-brand-500"
          >
            Get started
          </Link>
          <Link
            href="/#features"
            className="rounded-lg border border-white/10 px-6 py-3 font-medium text-white transition hover:bg-white/5"
          >
            Explore features
          </Link>
        </div>
      </div>
    </section>
  );
}
