import Link from "next/link";
import { APP_NAME } from "@/lib/config";

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
    <div className="glow flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <Link
        href="/"
        className="mb-8 flex items-center gap-2 text-xl font-semibold text-white"
      >
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          {APP_NAME.charAt(0).toUpperCase()}
        </span>
        {APP_NAME}
      </Link>

      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-ink-800 p-8">
        <h1 className="text-2xl font-bold text-white">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-slate-400">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>

      {footer && (
        <div className="mt-6 text-center text-sm text-slate-400">{footer}</div>
      )}
    </div>
  );
}
