"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthLayout } from "@/components/AuthLayout";
import { Alert, fieldClass, labelClass, primaryButtonClass } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } finally {
      // Always show the same confirmation, regardless of whether the email exists.
      setSent(true);
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle={
        sent
          ? undefined
          : "Enter your email and we'll send you a reset link."
      }
      footer={
        <Link
          href="/login"
          className="text-brand-400 transition hover:text-brand-300"
        >
          Back to log in
        </Link>
      }
    >
      {sent ? (
        <Alert kind="success">
          If an account exists for <strong>{email}</strong>, a password-reset
          link is on its way. The link expires in one hour.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={fieldClass}
              placeholder="you@example.com"
            />
          </div>

          <button type="submit" disabled={loading} className={primaryButtonClass}>
            {loading ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
