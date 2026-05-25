"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthLayout } from "@/components/AuthLayout";
import { Alert, fieldClass, labelClass, primaryButtonClass } from "@/components/ui";
import { planName } from "@/lib/config";

type Status = "loading" | "ready" | "blocked";

export function SignupForm({ sessionId }: { sessionId: string }) {
  const router = useRouter();

  const [status, setStatus] = useState<Status>("loading");
  const [blockedReason, setBlockedReason] = useState("");
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState("");

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Verify the purchase with the checkout session. Callable so a retry
  // button can re-run it without the customer paying again.
  const verifyPurchase = useCallback(async () => {
    if (!sessionId) {
      setStatus("blocked");
      return;
    }
    setStatus("loading");
    setBlockedReason("");
    try {
      const res = await fetch(
        `/api/checkout/verify?session_id=${encodeURIComponent(sessionId)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not verify your purchase.");
      setEmail(data.email);
      setPlan(data.plan);
      setStatus("ready");
    } catch (err) {
      setBlockedReason(
        err instanceof Error ? err.message : "Could not verify your purchase."
      );
      setStatus("blocked");
    }
  }, [sessionId]);

  // Run verification once when the page loads.
  useEffect(() => {
    verifyPurchase();
  }, [verifyPurchase]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, name, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create your account.");
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create your account.");
      setSubmitting(false);
    }
  }

  if (status === "loading") {
    return (
      <AuthLayout title="Almost there" subtitle="Verifying your purchase…">
        <div className="h-24 animate-pulse rounded-lg bg-white/5" />
      </AuthLayout>
    );
  }

  if (status === "blocked") {
    const hasSession = Boolean(sessionId);
    return (
      <AuthLayout
        title={hasSession ? "We couldn't verify your purchase" : "Choose a plan first"}
        subtitle={
          hasSession
            ? "Your payment may still be processing."
            : "Accounts are created right after checkout."
        }
        footer={
          <>
            Already have an account?{" "}
            <Link
              href="/login"
              className="text-brand-400 transition hover:text-brand-300"
            >
              Log in
            </Link>
          </>
        }
      >
        <div className="space-y-4">
          {blockedReason && <Alert>{blockedReason}</Alert>}

          {hasSession ? (
            <>
              <p className="text-sm text-slate-400">
                A payment can take a few seconds to settle. Wait a moment, then
                retry — you won&apos;t be charged again.
              </p>
              <button
                type="button"
                onClick={() => verifyPurchase()}
                className={primaryButtonClass}
              >
                Try again
              </button>
              <Link
                href="/#pricing"
                className="block text-center text-sm text-slate-400 transition hover:text-white"
              >
                Back to plans
              </Link>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-400">
                To create an account you need an active membership. Pick a plan
                and complete checkout — you&apos;ll land back here automatically.
              </p>
              <Link
                href="/#pricing"
                className={`${primaryButtonClass} inline-block text-center`}
              >
                View plans
              </Link>
            </>
          )}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle={`Membership confirmed — you're on the ${planName(plan)} plan.`}
      footer={
        <>
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-brand-400 transition hover:text-brand-300"
          >
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className={labelClass}>
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            disabled
            className={fieldClass}
          />
          <p className="mt-1 text-xs text-slate-500">
            Linked to your purchase and cannot be changed.
          </p>
        </div>

        <div>
          <label htmlFor="name" className={labelClass}>
            Full name
          </label>
          <input
            id="name"
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
            placeholder="Ada Lovelace"
          />
        </div>

        <div>
          <label htmlFor="password" className={labelClass}>
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={fieldClass}
            placeholder="At least 8 characters"
          />
        </div>

        {error && <Alert>{error}</Alert>}

        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthLayout>
  );
}
