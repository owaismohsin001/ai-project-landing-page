"use client";

import { useState } from "react";
import Link from "next/link";
import { ENTERPRISE_FEATURES, PLAN_LIST, type PlanId } from "@/lib/config";

/**
 * Pricing section. Clicking a plan starts Stripe Checkout; after a successful
 * payment the customer is redirected to /signup to create their account.
 */
export function Pricing() {
  const [loading, setLoading] = useState<PlanId | null>(null);
  const [error, setError] = useState("");

  async function startCheckout(plan: PlanId) {
    setError("");
    setLoading(plan);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Could not start checkout.");
      }
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(null);
    }
  }

  return (
    <section
      id="pricing"
      className="mx-auto max-w-6xl scroll-mt-16 px-6 py-24"
    >
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold text-slate-900 sm:text-4xl dark:text-white">
          Simple, transparent pricing
        </h2>
        <p className="mt-4 text-slate-600 dark:text-slate-300">
          Pick a membership and create your account right after checkout.
        </p>
      </div>

      {error && (
        <p className="mx-auto mt-6 max-w-md rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-center text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="mt-14 grid gap-6 lg:grid-cols-4">
        {PLAN_LIST.map((plan) => (
          <div
            key={plan.id}
            className={`relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm shadow-slate-900/[0.04] dark:bg-ink-800 dark:shadow-none ${
              plan.popular
                ? "border-brand-500"
                : "border-slate-200 dark:border-white/5"
            }`}
          >
            {plan.popular && (
              <span className="absolute -top-3 left-6 rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white">
                Most popular
              </span>
            )}
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
              {plan.name}
            </h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {plan.tagline}
            </p>

            <div className="mt-5 flex items-baseline gap-1.5">
              <span className="text-4xl font-bold text-slate-900 dark:text-white">
                ${plan.price}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                / month
              </span>
            </div>

            <ul className="mt-6 flex-1 space-y-3 text-sm text-slate-700 dark:text-slate-300">
              {plan.features.map((feat) => (
                <li key={feat} className="flex gap-2">
                  <span className="text-brand-500 dark:text-brand-400">✓</span>
                  {feat}
                </li>
              ))}
            </ul>

            <button
              onClick={() => startCheckout(plan.id)}
              disabled={loading !== null}
              className={`mt-8 w-full rounded-lg px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                plan.popular
                  ? "bg-brand-600 text-white hover:bg-brand-500"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:border-white/10 dark:bg-transparent dark:text-white dark:hover:bg-white/5"
              }`}
            >
              {loading === plan.id ? "Redirecting…" : "Get started"}
            </button>
          </div>
        ))}

        {/* Enterprise — no fixed price, routes to the contact form. */}
        <div className="flex flex-col rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white p-6 shadow-sm shadow-slate-900/[0.04] dark:border-white/5 dark:from-ink-700 dark:to-ink-800 dark:shadow-none">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
            Enterprise
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            For organizations with custom needs.
          </p>

          <div className="mt-5 flex items-baseline">
            <span className="text-4xl font-bold text-slate-900 dark:text-white">
              Custom
            </span>
          </div>

          <ul className="mt-6 flex-1 space-y-3 text-sm text-slate-700 dark:text-slate-300">
            {ENTERPRISE_FEATURES.map((feat) => (
              <li key={feat} className="flex gap-2">
                <span className="text-brand-500 dark:text-brand-400">✓</span>
                {feat}
              </li>
            ))}
          </ul>

          <Link
            href="/contact"
            className="mt-8 w-full rounded-lg border border-brand-500/40 bg-brand-50 px-4 py-2.5 text-center text-sm font-medium text-brand-700 transition hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-200 dark:hover:bg-brand-500/20"
          >
            Contact sales
          </Link>
        </div>
      </div>

      <p className="mt-8 text-center text-xs text-slate-500 dark:text-slate-500">
        Billed monthly via Stripe — cancel anytime. You&apos;ll create your
        account right after checkout.
      </p>
    </section>
  );
}
