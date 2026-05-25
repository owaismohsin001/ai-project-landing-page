"use client";

import { useCallback, useEffect, useState } from "react";

interface State {
  status: string;
  url: string | null;
}

/**
 * Header-level CTA. When the workspace is ready, it opens the URL in a new
 * tab. Otherwise it smooth-scrolls down to the workspace card so the user
 * can provision (or retry) from there.
 *
 * Polls /api/workspace every 8s so the label stays accurate without a
 * manual refresh while provisioning finishes.
 */
export function WorkspaceCTA({
  initialStatus,
  initialUrl,
}: {
  initialStatus: string;
  initialUrl: string | null;
}) {
  const [state, setState] = useState<State>({
    status: initialStatus,
    url: initialUrl,
  });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setState({
        status: data.status ?? "none",
        url: data.workspace?.url ?? null,
      });
    } catch {
      // transient — next poll retries
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleClick() {
    setBusy(true);
    // Fetch fresh state before deciding — the polled state could be a few
    // seconds stale; we don't want to scroll the user when the workspace
    // just became ready.
    let current: State = state;
    try {
      const res = await fetch("/api/workspace", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        current = {
          status: data.status ?? "none",
          url: data.workspace?.url ?? null,
        };
        setState(current);
      }
    } catch {
      // fall back to last known state
    }

    if (current.status === "ready" && current.url) {
      window.open(current.url, "_blank", "noopener,noreferrer");
    } else {
      document
        .getElementById("workspace-section")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setBusy(false);
  }

  const isReady = state.status === "ready" && Boolean(state.url);
  const isInFlight =
    state.status === "provisioning" || state.status === "destroying";

  const label = busy
    ? "Loading…"
    : isReady
      ? "Open workspace"
      : isInFlight
        ? state.status === "provisioning"
          ? "Setup in progress…"
          : "Tearing down…"
        : "Set up workspace";

  const styles = isReady
    ? "border-brand-500/30 bg-gradient-to-br from-brand-600 to-brand-700 text-white shadow-lg shadow-brand-600/30 hover:from-brand-500 hover:to-brand-600"
    : isInFlight
      ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/15"
      : "border-slate-200 bg-white text-slate-800 shadow-sm hover:bg-slate-50 hover:text-slate-900 dark:border-white/10 dark:bg-white/5 dark:text-white dark:shadow-none dark:hover:bg-white/10";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${styles}`}
    >
      {isInFlight && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
        </span>
      )}
      <span>{label}</span>
      {isReady ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden
        >
          <path d="M7 17L17 7" />
          <path d="M8 7h9v9" />
        </svg>
      ) : !isInFlight ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      ) : null}
    </button>
  );
}
