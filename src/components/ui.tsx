/** Shared presentational styles and pieces used across forms.
 *
 * Each class string is "light first → dark variants tacked on" so it
 * works under both themes without needing the consumer to know which one
 * is active. The `.dark` class on `<html>` (managed by ThemeProvider)
 * flips Tailwind's `dark:` variants on/off globally.
 */

export const fieldClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:opacity-60 dark:border-white/10 dark:bg-ink-900 dark:text-white dark:placeholder-slate-500";

export const labelClass =
  "mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300";

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
      ? "border-red-300 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
      : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300";
  return (
    <p className={`rounded-lg border px-3.5 py-2.5 text-sm ${styles}`}>
      {children}
    </p>
  );
}