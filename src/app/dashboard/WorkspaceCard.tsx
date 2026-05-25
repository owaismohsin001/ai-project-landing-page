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
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  async function startDestroying() {
    if (
      !window.confirm(
        "Destroy this workspace? The EC2 instance, S3 bucket, IAM user and all snapshots will be permanently deleted."
      )
    ) {
      return;
    }
    setActionError("");
    setDestroying(true);
    try {
      const res = await fetch("/api/workspace", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        throw new Error(data.error || "Could not start destroy.");
      }
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
    <div className="rounded-2xl border border-white/5 bg-ink-800 p-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">Workspace</p>
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
            onClick={startDestroying}
            disabled={destroying}
            className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {destroying ? "Destroying…" : "Delete workspace"}
          </button>
        )}
      </div>

      {actionError && (
        <p className="mt-2 text-sm text-red-400">{actionError}</p>
      )}

      {/* Status-specific helper text. */}
      {state.status === "provisioning" && (
        <p className="mt-4 text-sm text-slate-300">
          Spinning up your dedicated EC2 instance, S3 bucket, and IAM user.
          This usually takes 3–5 minutes — leave this page open and it&apos;ll
          update on its own.
        </p>
      )}

      {state.status === "destroying" && (
        <p className="mt-4 text-sm text-slate-300">
          Tearing down workspace resources…
        </p>
      )}

      {state.status === "failed" && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          Last attempt failed.{" "}
          {state.error && (
            <span className="text-red-200/80">{state.error}</span>
          )}{" "}
          Click <strong>Open workspace</strong> to try again, or{" "}
          <strong>Delete workspace</strong> to clean up half-built resources.
        </div>
      )}

      {(state.status === "none" || state.status === "destroyed") && (
        <p className="mt-4 text-sm text-slate-400">
          {state.status === "destroyed"
            ? "Workspace has been removed. Click Open workspace to provision a new one."
            : "No workspace yet. Click Open workspace to create one — your dedicated EC2 + S3 + IAM user."}
        </p>
      )}

      {/* Resource details for ready workspaces. */}
      {state.workspace && state.status === "ready" && (
        <dl className="mt-5 grid gap-3 border-t border-white/5 pt-5 text-sm sm:grid-cols-2">
          <Field label="Instance" value={state.workspace.instanceId} mono />
          <Field
            label="Public DNS"
            value={state.workspace.publicDns || "—"}
            mono
          />
          <Field
            label="Public IP"
            value={state.workspace.publicIp || "—"}
            mono
          />
          <Field label="S3 bucket" value={state.workspace.bucketName} mono />
          <Field
            label="IAM key id"
            value={state.workspace.iamAccessKeyId}
            mono
          />
          <Field label="URL" value={state.workspace.url} mono />
        </dl>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    provisioning: "border-brand-500/30 bg-brand-500/10 text-brand-300",
    destroying: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    failed: "border-red-500/30 bg-red-500/10 text-red-300",
    destroyed: "border-white/10 bg-white/5 text-slate-300",
    none: "border-white/10 bg-white/5 text-slate-400",
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

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd
        className={`mt-0.5 break-all text-slate-200 ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
