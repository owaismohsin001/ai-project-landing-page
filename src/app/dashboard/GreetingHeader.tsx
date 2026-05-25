"use client";

import { useEffect, useState } from "react";

function timeGreeting(date: Date): string {
  const h = date.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function GreetingHeader({ name }: { name: string }) {
  const [now, setNow] = useState<Date | null>(null);

  // Render client-side only to avoid SSR / TZ mismatch; tick every 30s so the
  // clock and the greeting boundary (e.g. noon → afternoon) stay accurate.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!now) {
    return (
      <>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl dark:text-white">
          Welcome,{" "}
          <span className="bg-gradient-to-r from-brand-600 to-purple-600 bg-clip-text text-transparent dark:from-brand-300 dark:to-purple-300">
            {name}
          </span>{" "}
          👋
        </h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          &nbsp;
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl dark:text-white">
        {timeGreeting(now)},{" "}
        <span className="bg-gradient-to-r from-brand-600 to-purple-600 bg-clip-text text-transparent dark:from-brand-300 dark:to-purple-300">
          {name}
        </span>{" "}
        👋
      </h1>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
        <span>{formatDate(now)}</span>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <span className="font-medium tabular-nums text-slate-700 dark:text-slate-300">
          {formatTime(now)}
        </span>
      </p>
    </>
  );
}
