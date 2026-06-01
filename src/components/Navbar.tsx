import Link from "next/link";
import { APP_NAME } from "@/lib/config";
import { ThemeToggle } from "./ThemeToggle";

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-white/5 dark:bg-ink-900/80">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-white"
        >
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            {APP_NAME.charAt(0).toUpperCase()}
          </span>
          {APP_NAME}
        </Link>

        <div className="flex items-center gap-6 text-sm">
          <Link
            href="/#features"
            className="hidden text-slate-600 transition hover:text-slate-900 sm:block dark:text-slate-300 dark:hover:text-white"
          >
            Features
          </Link>
          <Link
            href="/#pricing"
            className="hidden text-slate-600 transition hover:text-slate-900 sm:block dark:text-slate-300 dark:hover:text-white"
          >
            Pricing
          </Link>
          <Link
            href="/login"
            className="text-slate-600 transition hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
          >
            Log in
          </Link>
          <Link
            href="/#pricing"
            className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white transition hover:bg-brand-500"
          >
            Get started
          </Link>
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}