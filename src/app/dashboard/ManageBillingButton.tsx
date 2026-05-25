"use client";

import { useState } from "react";

/** Opens the Stripe Billing Portal so the member can manage their plan. */
export function ManageBillingButton({
  label = "Manage billing",
  variant = "subtle",
}: {
  label?: string;
  variant?: "subtle" | "primary";
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function openPortal() {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Could not open the billing portal.");
      }
      window.location.href = data.url;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not open the billing portal."
      );
      setLoading(false);
    }
  }

  const className =
    variant === "primary"
      ? "rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:opacity-60"
      : "rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 hover:text-slate-900 disabled:opacity-60 dark:border-white/10 dark:bg-transparent dark:text-white dark:shadow-none dark:hover:bg-white/5";

  return (
    <div className="flex flex-col items-start gap-1">
      <button onClick={openPortal} disabled={loading} className={className}>
        {loading ? "Opening…" : label}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
