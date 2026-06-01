import Link from "next/link";
import { APP_NAME } from "@/lib/config";

export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white dark:border-white/5 dark:bg-ink-900">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-slate-600 sm:flex-row dark:text-slate-400">
        <p>
          © {new Date().getFullYear()} {APP_NAME}. All rights reserved.
        </p>
        <div className="flex flex-wrap justify-center gap-6">
          <Link
            href="/#features"
            className="transition hover:text-slate-900 dark:hover:text-white"
          >
            Features
          </Link>
          <Link
            href="/#pricing"
            className="transition hover:text-slate-900 dark:hover:text-white"
          >
            Pricing
          </Link>
          <Link
            href="/contact"
            className="transition hover:text-slate-900 dark:hover:text-white"
          >
            Contact sales
          </Link>
          <Link
            href="/login"
            className="transition hover:text-slate-900 dark:hover:text-white"
          >
            Log in
          </Link>
        </div>
      </div>
    </footer>
  );
}
