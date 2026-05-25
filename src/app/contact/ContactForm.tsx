"use client";

import { useState } from "react";
import Link from "next/link";
import { Alert, fieldClass, labelClass, primaryButtonClass } from "@/components/ui";

export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, company, message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not send your message.");
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your message.");
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <Alert kind="success">
          Thanks, {name.split(" ")[0] || "there"}! Your message is in — our
          sales team will be in touch shortly.
        </Alert>
        <Link
          href="/"
          className="inline-block text-sm text-brand-400 transition hover:text-brand-300"
        >
          ← Back to home
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className={labelClass}>
            Full name
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
            placeholder="Ada Lovelace"
          />
        </div>
        <div>
          <label htmlFor="email" className={labelClass}>
            Work email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
            placeholder="you@company.com"
          />
        </div>
      </div>

      <div>
        <label htmlFor="company" className={labelClass}>
          Company
        </label>
        <input
          id="company"
          type="text"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className={fieldClass}
          placeholder="Company name"
        />
      </div>

      <div>
        <label htmlFor="message" className={labelClass}>
          How can we help?
        </label>
        <textarea
          id="message"
          required
          rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className={`${fieldClass} resize-y`}
          placeholder="Tell us about your team, expected usage, and any requirements."
        />
      </div>

      {error && <Alert>{error}</Alert>}

      <button type="submit" disabled={loading} className={primaryButtonClass}>
        {loading ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}
