/** Shared presentational styles and pieces used across forms. */

export const fieldClass =
  "w-full rounded-lg border border-white/10 bg-ink-900 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:opacity-60";

export const labelClass = "mb-1.5 block text-sm font-medium text-slate-300";

export const primaryButtonClass =
  "w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60";

/** Inline error / success banner. */
export function Alert({
  kind = "error",
  children,
}: {
  kind?: "error" | "success";
  children: React.ReactNode;
}) {
  const styles =
    kind === "error"
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  return (
    <p className={`rounded-lg border px-3.5 py-2.5 text-sm ${styles}`}>
      {children}
    </p>
  );
}
