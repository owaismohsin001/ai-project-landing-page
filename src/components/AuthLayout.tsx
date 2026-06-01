import Link from "next/link";
import { APP_NAME } from "@/lib/config";
import { ThemeToggle } from "./ThemeToggle";

/** Centered card layout shared by every auth screen. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="glow relative flex min-h-screen flex-col items-center justify-center px-6 py-12">
      {/* Top-right theme toggle so users on an auth screen can flip
          modes without bouncing back to the marketing site nav. */}
      <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
        <ThemeToggle />
      </div>

      <Link
        href="/"
        className="mb-8 flex items-center gap-2 text-xl font-semibold text-slate-900 dark:text-white"
      >
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          {APP_NAME.charAt(0).toUpperCase()}
        </span>
        {APP_NAME}
      </Link>

      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm shadow-slate-900/[0.04] dark:border-white/10 dark:bg-ink-800 dark:shadow-none">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            {subtitle}
          </p>
        )}
        <div className="mt-6">{children}</div>
      </div>

      {footer && (
        <div className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
          {footer}
        </div>
      )}
    </div>
  );
}