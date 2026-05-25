"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthLayout } from "@/components/AuthLayout";
import { Alert, fieldClass, labelClass, primaryButtonClass } from "@/components/ui";

export function ResetForm({ token, email }: { token: string; email: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const linkValid = Boolean(token && email);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not reset your password.");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset your password.");
      setLoading(false);
    }
  }

  if (!linkValid) {
    return (
      <AuthLayout
        title="Invalid reset link"
        subtitle="This link is missing information or has expired."
        footer={
          <Link
            href="/forgot-password"
            className="text-brand-400 transition hover:text-brand-300"
          >
            Request a new link
          </Link>
        }
      >
        <Alert>
          Please request a fresh password-reset link and try again.
        </Alert>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout
        title="Password updated"
        footer={
          <Link
            href="/login"
            className="text-brand-400 transition hover:text-brand-300"
          >
            Continue to log in
          </Link>
        }
      >
        <Alert kind="success">
          Your password has been changed. You can now log in with it.
        </Alert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle={`Resetting the password for ${email}.`}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="password" className={labelClass}>
            New password
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

        <div>
          <label htmlFor="confirm" className={labelClass}>
            Confirm password
          </label>
          <input
            id="confirm"
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={fieldClass}
            placeholder="Re-enter your password"
          />
        </div>

        {error && <Alert>{error}</Alert>}

        <button type="submit" disabled={loading} className={primaryButtonClass}>
          {loading ? "Updating…" : "Update password"}
        </button>
      </form>
    </AuthLayout>
  );
}
