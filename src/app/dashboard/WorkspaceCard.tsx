"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface WorkspaceData {
  instanceId: string;
  publicIp: string;
  publicDns: string;
  bucketName: string;
  iamAccessKeyId: string;
  url: string;
}

interface WorkspaceState {
  status: string;
  error: string | null;
  workspace: WorkspaceData | null;
}

interface Props {
  initial: WorkspaceState;
}

const POLLING_STATUSES = new Set(["provisioning", "destroying"]);

export function WorkspaceCard({ initial }: Props) {
  const [state, setState] = useState<WorkspaceState>(initial);
  const [starting, setStarting] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [actionError, setActionError] = useState("");
  const [progress, setProgress] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Time-based fake progress for the provisioning bar. Caps at 95% so we never
  // claim "done" before the backend actually reports ready — the jump to 100%
  // happens when status transitions to "ready".
  useEffect(() => {
    if (state.status === "ready") {
      setProgress(100);
      return;
    }
    if (state.status !== "provisioning") {
      setProgress(0);
      return;
    }
    const startedAt = Date.now();
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      setProgress(Math.min(95, (elapsed / 240_000) * 100));
    };
    tick();
    const id = setInterval(tick, 800);
    return () => clearInterval(id);
  }, [state.status]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as WorkspaceState;
      setState(data);
    } catch {
      // ignore transient fetch errors — next tick will retry
    }
  }, []);

  // Initial refresh on mount, plus polling whenever the status is in-flight.
  useEffect(() => {
    refresh();
    if (POLLING_STATUSES.has(state.status)) {
      timer.current = setInterval(refresh, 5000);
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [state.status, refresh]);

  async function startProvisioning() {
    setActionError("");
    setStarting(true);
    try {
      const res = await fetch("/api/workspace", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        throw new Error(data.error || "Could not start provisioning.");
      }
      await refresh();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not start provisioning."
      );
    } finally {
      setStarting(false);
    }
  }

  async function performDestroy() {
    setActionError("");
    setDestroying(true);
    try {
      const res = await fetch("/api/workspace", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        throw new Error(data.error || "Could not start destroy.");
      }
      setConfirmOpen(false);
      await refresh();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not start destroy."
      );
    } finally {
      setDestroying(false);
    }
  }

  const isReady = state.status === "ready" && Boolean(state.workspace?.url);
  const isInFlight =
    state.status === "provisioning" || state.status === "destroying";
  const canStart = !isReady && !isInFlight && !starting && !destroying;
  // Delete is offered whenever there's something to clean up (ready or
  // half-built failure) and we're not already mid-flight.
  const canDestroy =
    (state.status === "ready" || state.status === "failed") &&
    !isInFlight &&
    !destroying;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-900/[0.03] dark:border-white/5 dark:bg-ink-800 dark:shadow-none">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500 dark:text-slate-400">Workspace</p>
        <StatusPill status={state.status} />
      </div>

      {/* Action row — primary "open / create" + secondary "delete". */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {isReady ? (
          <a
            href={state.workspace!.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-500"
          >
            Open workspace
            <span aria-hidden>↗</span>
          </a>
        ) : (
          <button
            type="button"
            onClick={startProvisioning}
            disabled={!canStart}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {state.status === "provisioning"
              ? "Creating workspace…"
              : state.status === "destroying"
                ? "Tearing down…"
                : starting
                  ? "Starting…"
                  : "Open workspace"}
          </button>
        )}

        {canDestroy && (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={destroying}
            className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
          >
            {destroying ? "Destroying…" : "Delete workspace"}
          </button>
        )}
      </div>

      <ConfirmDeleteModal
        open={confirmOpen}
        busy={destroying}
        onClose={() => setConfirmOpen(false)}
        onConfirm={performDestroy}
      />

      {actionError && (
        <p className="mt-2 text-sm text-rose-600 dark:text-red-400">
          {actionError}
        </p>
      )}

      {/* Status-specific helper text. */}
      {state.status === "provisioning" && (
        <div className="mt-4 space-y-3">
          <div className="flex items-start gap-4">
            <Gears />
            <p className="flex-1 text-sm text-slate-600 dark:text-slate-300">
              Spinning up your dedicated EC2 instance, S3 bucket, and IAM
              user. This usually takes 3–5 minutes — leave this page open and
              it&apos;ll update on its own.
            </p>
          </div>
          <ProgressBar value={progress} />
        </div>
      )}

      {state.status === "destroying" && (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          Tearing down workspace resources…
        </p>
      )}

      {state.status === "failed" && (
        <div className="mt-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          Last attempt failed.{" "}
          {state.error && (
            <span className="text-rose-600/90 dark:text-red-200/80">
              {state.error}
            </span>
          )}{" "}
          Click <strong>Open workspace</strong> to try again, or{" "}
          <strong>Delete workspace</strong> to clean up half-built resources.
        </div>
      )}

      {(state.status === "none" || state.status === "destroyed") && (
        <EmptyState destroyed={state.status === "destroyed"} />
      )}

      {/* Resource details for ready workspaces. */}
      {state.workspace && state.status === "ready" && (
        <div className="mt-5 border-t border-slate-200 pt-5 dark:border-white/5">
          <ReadyBanner />
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field
              label="Instance"
              value={state.workspace.instanceId}
              tone="blue"
            />
            <Field
              label="Public DNS"
              value={state.workspace.publicDns || "—"}
              tone="purple"
            />
            <Field
              label="Public IP"
              value={state.workspace.publicIp || "—"}
              tone="cyan"
            />
            <Field
              label="S3 bucket"
              value={state.workspace.bucketName}
              tone="amber"
            />
            <Field
              label="IAM key id"
              value={state.workspace.iamAccessKeyId}
              tone="rose"
            />
            <Field
              label="URL"
              value={state.workspace.url}
              tone="emerald"
              href
            />
          </dl>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready:
      "border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    provisioning:
      "border-brand-300 bg-brand-100 text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300",
    destroying:
      "border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
    failed:
      "border-rose-300 bg-rose-100 text-rose-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
    destroyed:
      "border-slate-300 bg-slate-100 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300",
    none: "border-slate-300 bg-slate-100 text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400",
  };
  const cls = styles[status] ?? styles.none;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {(status === "provisioning" || status === "destroying") && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status}
    </span>
  );
}

function Gears() {
  return (
    <div
      className="relative h-12 w-14 flex-shrink-0"
      aria-hidden
      role="presentation"
    >
      <GearIcon
        className="absolute left-0 top-0 h-8 w-8 animate-spin text-brand-400"
        style={{ animationDuration: "4s" }}
      />
      <GearIcon
        className="absolute bottom-0 right-0 h-7 w-7 animate-spin text-brand-500 [animation-direction:reverse]"
        style={{ animationDuration: "3s" }}
      />
    </div>
  );
}

function GearIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  // Hue sweep: 0% → red (hue 0), 50% → yellow (hue 60), 100% → green (hue 120).
  // Universal "progress towards complete" color language.
  const hue = (pct / 100) * 120;
  const endHue = Math.min(120, hue + 25);
  const fillBg = `linear-gradient(90deg, hsl(${hue} 92% 50%), hsl(${endHue} 92% 60%))`;
  const textColor = `hsl(${hue} 92% 68%)`;
  const glow = `0 0 14px hsl(${hue} 92% 55% / 0.55), 0 0 4px hsl(${hue} 92% 55% / 0.8)`;

  return (
    <div className="flex items-center gap-3">
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-slate-200 ring-1 ring-inset ring-slate-200 dark:bg-white/5 dark:ring-white/5"
      >
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{
            width: `${pct}%`,
            background: fillBg,
            boxShadow: glow,
          }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 animate-[shimmer_1.8s_linear_infinite] bg-gradient-to-r from-transparent via-white/30 to-transparent"
          style={{ mixBlendMode: "overlay" }}
        />
      </div>
      <span
        className="min-w-[3.5ch] text-right text-sm font-bold tabular-nums transition-colors duration-700"
        style={{
          color: textColor,
          textShadow: `0 0 10px hsl(${hue} 92% 55% / 0.4)`,
        }}
      >
        {Math.round(pct)}%
      </span>
    </div>
  );
}

function EmptyState({ destroyed }: { destroyed: boolean }) {
  const steps = [
    {
      label: "EC2 instance",
      desc: "Dedicated virtual machine",
      tone: "blue" as const,
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden
        >
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      ),
    },
    {
      label: "S3 bucket",
      desc: "Object storage",
      tone: "amber" as const,
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden
        >
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
        </svg>
      ),
    },
    {
      label: "IAM user",
      desc: "Scoped access keys",
      tone: "rose" as const,
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden
        >
          <circle cx="9" cy="11" r="4" />
          <path d="M9 15v3" />
          <path d="M15 7l6 6m0-6l-6 6" opacity="0.4" />
          <path d="M13 11h8" />
          <circle cx="17" cy="11" r="1.5" fill="currentColor" />
        </svg>
      ),
    },
  ];

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-5 dark:border-white/[0.06] dark:from-white/[0.02] dark:to-transparent">
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-100 to-purple-100 ring-1 ring-brand-200 dark:from-brand-500/20 dark:to-purple-500/10 dark:ring-brand-500/20">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6 text-brand-600 dark:text-brand-300"
            aria-hidden
          >
            <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-slate-900 dark:text-white">
            {destroyed
              ? "Spin up a new workspace"
              : "Ready to provision your environment?"}
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {destroyed
              ? "Your previous workspace was removed. Create a fresh one — same dedicated AWS resources, ready in 3–5 minutes."
              : "We'll provision your own AWS resources, isolated and ready for development. Takes 3–5 minutes."}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-2.5 sm:grid-cols-3">
        {steps.map((step, i) => (
          <StepChip
            key={step.label}
            num={i + 1}
            icon={step.icon}
            label={step.label}
            desc={step.desc}
            tone={step.tone}
          />
        ))}
      </div>

      <div className="mt-5 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-500">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        Provisioning typically takes 3–5 minutes — leave the page open.
      </div>
    </div>
  );
}

function StepChip({
  num,
  icon,
  label,
  desc,
  tone,
}: {
  num: number;
  icon: React.ReactNode;
  label: string;
  desc: string;
  tone: "blue" | "amber" | "rose";
}) {
  const TONE_MAP = {
    blue: {
      border: "border-blue-200 dark:border-blue-500/15",
      bg: "bg-blue-50/80 dark:bg-blue-500/[0.04]",
      iconWrap:
        "bg-blue-100 text-blue-700 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/20",
      num: "bg-blue-200 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
    },
    amber: {
      border: "border-amber-200 dark:border-amber-500/15",
      bg: "bg-amber-50/80 dark:bg-amber-500/[0.04]",
      iconWrap:
        "bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
      num: "bg-amber-200 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    },
    rose: {
      border: "border-rose-200 dark:border-rose-500/15",
      bg: "bg-rose-50/80 dark:bg-rose-500/[0.04]",
      iconWrap:
        "bg-rose-100 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20",
      num: "bg-rose-200 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
    },
  } as const;
  const t = TONE_MAP[tone];
  return (
    <div
      className={`relative flex items-center gap-3 rounded-lg border p-3 ${t.border} ${t.bg}`}
    >
      <div
        className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ring-1 ${t.iconWrap}`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
          <span
            className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${t.num}`}
          >
            {num}
          </span>
          {label}
        </p>
        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
          {desc}
        </p>
      </div>
    </div>
  );
}

function ConfirmDeleteModal({
  open,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // ESC + body scroll lock + initial focus on Cancel (the safer default).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-workspace-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
    >
      <div
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm dark:bg-black/70"
        onClick={() => !busy && onClose()}
        aria-hidden
      />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl shadow-slate-900/20 animate-modal-in dark:border-white/10 dark:bg-ink-800 dark:shadow-rose-950/30">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-rose-100 ring-1 ring-rose-300 dark:bg-rose-500/15 dark:ring-rose-500/30">
            <WarningIcon className="h-6 w-6 text-rose-600 dark:text-rose-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="delete-workspace-title"
              className="text-lg font-semibold text-slate-900 dark:text-white"
            >
              Delete workspace?
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              This action is permanent and cannot be undone.
            </p>
          </div>
        </div>

        <ul className="mt-5 space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-slate-700 dark:border-rose-500/15 dark:bg-rose-500/[0.05] dark:text-slate-300">
          {[
            "EC2 instance will be terminated",
            "S3 bucket and all contents deleted",
            "IAM user and access keys removed",
            "All snapshots permanently destroyed",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2.5">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-rose-500 dark:bg-rose-400" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-600/30 transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && (
              <svg
                className="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeOpacity="0.25"
                  strokeWidth="4"
                />
                <path
                  d="M22 12a10 10 0 0 1-10 10"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              </svg>
            )}
            {busy ? "Deleting…" : "Yes, delete workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ReadyBanner() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 animate-fade-up dark:border-emerald-500/20 dark:bg-emerald-500/[0.06]">
      <SuccessCheck />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
          Workspace ready
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          All resources provisioned successfully.
        </p>
      </div>
    </div>
  );
}

function SuccessCheck() {
  return (
    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 animate-pop-in dark:bg-emerald-500/10">
      <svg
        viewBox="0 0 52 52"
        className="h-7 w-7 text-emerald-600 dark:text-emerald-400"
        aria-hidden
      >
        <circle
          cx="26"
          cy="26"
          r="24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeDasharray="166"
          strokeDashoffset="166"
          className="origin-center -rotate-90 animate-draw-circle"
          style={{ transformBox: "fill-box" }}
        />
        <path
          d="M14 27 L23 36 L38 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="48"
          strokeDashoffset="48"
          className="animate-draw-check"
        />
      </svg>
    </div>
  );
}

// Tag-style color tones. Each field card picks one to convey resource category
// at a glance (compute vs network vs storage vs credential vs endpoint).
// Listed as full literal classnames so Tailwind's JIT picks them up.
const TONES = {
  blue: {
    card: "border-blue-200 bg-blue-50/60 hover:border-blue-300 hover:bg-blue-50 dark:border-blue-500/20 dark:bg-blue-500/[0.04] dark:hover:border-blue-500/40 dark:hover:bg-blue-500/[0.08]",
    label: "text-blue-700 dark:text-blue-300",
    dot: "bg-blue-500 shadow-[0_0_8px_rgba(96,165,250,0.6)] dark:bg-blue-400",
    btn: "hover:bg-blue-100 hover:text-blue-700 focus:ring-blue-500/50 dark:hover:bg-blue-500/10 dark:hover:text-blue-200",
    link: "text-blue-700 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200",
  },
  purple: {
    card: "border-purple-200 bg-purple-50/60 hover:border-purple-300 hover:bg-purple-50 dark:border-purple-500/20 dark:bg-purple-500/[0.04] dark:hover:border-purple-500/40 dark:hover:bg-purple-500/[0.08]",
    label: "text-purple-700 dark:text-purple-300",
    dot: "bg-purple-500 shadow-[0_0_8px_rgba(192,132,252,0.6)] dark:bg-purple-400",
    btn: "hover:bg-purple-100 hover:text-purple-700 focus:ring-purple-500/50 dark:hover:bg-purple-500/10 dark:hover:text-purple-200",
    link: "text-purple-700 hover:text-purple-800 dark:text-purple-300 dark:hover:text-purple-200",
  },
  cyan: {
    card: "border-cyan-200 bg-cyan-50/60 hover:border-cyan-300 hover:bg-cyan-50 dark:border-cyan-500/20 dark:bg-cyan-500/[0.04] dark:hover:border-cyan-500/40 dark:hover:bg-cyan-500/[0.08]",
    label: "text-cyan-700 dark:text-cyan-300",
    dot: "bg-cyan-500 shadow-[0_0_8px_rgba(34,211,238,0.6)] dark:bg-cyan-400",
    btn: "hover:bg-cyan-100 hover:text-cyan-700 focus:ring-cyan-500/50 dark:hover:bg-cyan-500/10 dark:hover:text-cyan-200",
    link: "text-cyan-700 hover:text-cyan-800 dark:text-cyan-300 dark:hover:text-cyan-200",
  },
  amber: {
    card: "border-amber-200 bg-amber-50/60 hover:border-amber-300 hover:bg-amber-50 dark:border-amber-500/20 dark:bg-amber-500/[0.04] dark:hover:border-amber-500/40 dark:hover:bg-amber-500/[0.08]",
    label: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500 shadow-[0_0_8px_rgba(251,191,36,0.6)] dark:bg-amber-400",
    btn: "hover:bg-amber-100 hover:text-amber-700 focus:ring-amber-500/50 dark:hover:bg-amber-500/10 dark:hover:text-amber-200",
    link: "text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200",
  },
  rose: {
    card: "border-rose-200 bg-rose-50/60 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-500/20 dark:bg-rose-500/[0.04] dark:hover:border-rose-500/40 dark:hover:bg-rose-500/[0.08]",
    label: "text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500 shadow-[0_0_8px_rgba(251,113,133,0.6)] dark:bg-rose-400",
    btn: "hover:bg-rose-100 hover:text-rose-700 focus:ring-rose-500/50 dark:hover:bg-rose-500/10 dark:hover:text-rose-200",
    link: "text-rose-700 hover:text-rose-800 dark:text-rose-300 dark:hover:text-rose-200",
  },
  emerald: {
    card: "border-emerald-200 bg-emerald-50/60 hover:border-emerald-300 hover:bg-emerald-50 dark:border-emerald-500/20 dark:bg-emerald-500/[0.04] dark:hover:border-emerald-500/40 dark:hover:bg-emerald-500/[0.08]",
    label: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.6)] dark:bg-emerald-400",
    btn: "hover:bg-emerald-100 hover:text-emerald-700 focus:ring-emerald-500/50 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-200",
    link: "text-emerald-700 hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-200",
  },
} as const;

type Tone = keyof typeof TONES;

function Field({
  label,
  value,
  tone = "blue",
  href = false,
}: {
  label: string;
  value: string;
  tone?: Tone;
  href?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copyable = Boolean(value) && value !== "—";
  const t = TONES[tone];

  async function handleCopy() {
    if (!copyable) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts; silently no-op.
    }
  }

  return (
    <div
      className={`group relative rounded-lg border p-3 transition ${t.card}`}
    >
      <dt
        className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${t.label}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden />
        {label}
      </dt>
      <div className="mt-1.5 flex items-center gap-2">
        <dd className="min-w-0 flex-1 break-all font-mono text-xs text-slate-800 dark:text-slate-200">
          {href && copyable ? (
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              className={`transition hover:underline ${t.link}`}
            >
              {value}
            </a>
          ) : (
            value
          )}
        </dd>
        {copyable && (
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? `${label} copied` : `Copy ${label}`}
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-slate-400 opacity-0 transition focus:opacity-100 focus:outline-none focus:ring-1 group-hover:opacity-100 dark:text-slate-500 ${t.btn}`}
          >
            {copied ? (
              <CheckIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <CopyIcon className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
