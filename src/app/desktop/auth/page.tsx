"use client";

import { useEffect, useReducer, useRef } from "react";

// ── State machine ─────────────────────────────────────────────────────────────

type State =
  | { phase: "checking" }
  | { phase: "login"; error?: string; loading?: boolean }
  | { phase: "redirecting"; redirectUrl: string }
  | { phase: "no_workspace"; workspaceStatus: string }
  | { phase: "error"; message: string };

type Action =
  | { type: "need_login"; error?: string }
  | { type: "login_loading" }
  | { type: "login_error"; error: string }
  | { type: "redirect"; redirectUrl: string }
  | { type: "no_workspace"; workspaceStatus: string }
  | { type: "error"; message: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "need_login":
      return { phase: "login", error: action.error };
    case "login_loading":
      return state.phase === "login" ? { ...state, loading: true, error: undefined } : state;
    case "login_error":
      return { phase: "login", error: action.error };
    case "redirect":
      return { phase: "redirecting", redirectUrl: action.redirectUrl };
    case "no_workspace":
      return { phase: "no_workspace", workspaceStatus: action.workspaceStatus };
    case "error":
      return { phase: "error", message: action.message };
    default:
      return state;
  }
}

// ── Main component ────────────────────────────────────────────────────────────

// Inject the spinner keyframe once — Next.js doesn't have a globals import
// on this page, so we inline it via a <style> tag in the component.
const SPINNER_KEYFRAME = `@keyframes spin { to { transform: rotate(360deg); } }`;

export default function DesktopAuthPage() {
  const [state, dispatch] = useReducer(reducer, { phase: "checking" });
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // On mount: check if already authenticated and workspace is ready.
  useEffect(() => {
    checkAuth();
  }, []);

  // Once we have the aiide:// URL, redirect immediately. The browser will hand
  // it to the OS, which forwards it to the Electron app via the registered
  // aiide:// protocol handler.
  useEffect(() => {
    if (state.phase === "redirecting") {
      window.location.href = state.redirectUrl;
    }
  }, [state]);

  async function checkAuth() {
    try {
      const res = await fetch("/api/desktop/auth");
      if (res.ok) {
        const data = await res.json();
        dispatch({ type: "redirect", redirectUrl: data.redirectUrl });
      } else if (res.status === 401) {
        dispatch({ type: "need_login" });
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.error === "no_workspace") {
          dispatch({ type: "no_workspace", workspaceStatus: data.status });
        } else {
          dispatch({ type: "error", message: data.error ?? "Unexpected error." });
        }
      }
    } catch {
      dispatch({ type: "error", message: "Could not reach the server." });
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const email = emailRef.current?.value.trim() ?? "";
    const password = passwordRef.current?.value ?? "";
    if (!email || !password) return;

    dispatch({ type: "login_loading" });

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        dispatch({ type: "login_error", error: data.error ?? "Sign in failed." });
        return;
      }

      // Login set the session cookie — now fetch the workspace URL.
      await checkAuth();
    } catch {
      dispatch({ type: "login_error", error: "Could not reach the server." });
    }
  }

  return (
    <main style={styles.root}>
      <style>{SPINNER_KEYFRAME}</style>
      <div style={styles.card}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>⬡</span>
          <span style={styles.logoText}>AI IDE Studio</span>
        </div>

        {state.phase === "checking" && (
          <div style={styles.center}>
            <Spinner />
            <p style={styles.hint}>Checking your session…</p>
          </div>
        )}

        {state.phase === "login" && (
          <>
            <h1 style={styles.heading}>Connect Desktop App</h1>
            <p style={styles.sub}>Sign in to link your workspace with the desktop client.</p>

            {state.error && <p style={styles.errorBanner}>{state.error}</p>}

            <form onSubmit={handleLogin} style={styles.form}>
              <label style={styles.label}>
                Email
                <input
                  ref={emailRef}
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  style={styles.input}
                  placeholder="you@example.com"
                />
              </label>
              <label style={styles.label}>
                Password
                <input
                  ref={passwordRef}
                  type="password"
                  required
                  autoComplete="current-password"
                  style={styles.input}
                  placeholder="••••••••"
                />
              </label>
              <button
                type="submit"
                style={{
                  ...styles.btn,
                  opacity: state.loading ? 0.6 : 1,
                  cursor: state.loading ? "not-allowed" : "pointer",
                }}
                disabled={state.loading}
              >
                {state.loading ? "Signing in…" : "Sign in & Connect"}
              </button>
            </form>
          </>
        )}

        {state.phase === "redirecting" && (
          <div style={styles.center}>
            <Spinner />
            <p style={styles.heading}>Opening desktop app…</p>
            <p style={styles.hint}>
              If nothing happens,{" "}
              <a href={state.redirectUrl} style={styles.link}>
                click here
              </a>
              .
            </p>
          </div>
        )}

        {state.phase === "no_workspace" && (
          <div style={styles.center}>
            <p style={styles.heading}>Workspace not ready</p>
            <p style={styles.hint}>
              Status: <strong>{state.workspaceStatus}</strong>. Visit your{" "}
              <a href="/dashboard" style={styles.link}>
                dashboard
              </a>{" "}
              to provision your workspace, then return here.
            </p>
          </div>
        )}

        {state.phase === "error" && (
          <div style={styles.center}>
            <p style={styles.errorBanner}>{state.message}</p>
            <button style={styles.btnSecondary} onClick={checkAuth}>
              Retry
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: 32,
        height: 32,
        border: "3px solid #333",
        borderTopColor: "#7c3aed",
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
        margin: "0 auto 12px",
      }}
    />
  );
}

// ── Inline styles (no Tailwind dependency, self-contained page) ───────────────

const styles = {
  root: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#080808",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "24px",
  } satisfies React.CSSProperties,
  card: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: "#111",
    border: "1px solid #222",
    borderRadius: 12,
    padding: "40px 36px",
    boxShadow: "0 0 40px rgba(124,58,237,0.08)",
  } satisfies React.CSSProperties,
  logo: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 28,
    justifyContent: "center",
  } satisfies React.CSSProperties,
  logoIcon: {
    fontSize: 28,
    color: "#7c3aed",
  } satisfies React.CSSProperties,
  logoText: {
    fontSize: 18,
    fontWeight: 700,
    color: "#e5e5e5",
    letterSpacing: "0.02em",
  } satisfies React.CSSProperties,
  heading: {
    color: "#e5e5e5",
    fontSize: 20,
    fontWeight: 700,
    marginBottom: 8,
    textAlign: "center" as const,
  } satisfies React.CSSProperties,
  sub: {
    color: "#666",
    fontSize: 14,
    textAlign: "center" as const,
    marginBottom: 24,
  } satisfies React.CSSProperties,
  center: {
    textAlign: "center" as const,
    padding: "12px 0",
  } satisfies React.CSSProperties,
  form: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
  } satisfies React.CSSProperties,
  label: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    fontSize: 13,
    fontWeight: 500,
    color: "#aaa",
  } satisfies React.CSSProperties,
  input: {
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: 8,
    color: "#e5e5e5",
    fontSize: 14,
    padding: "10px 12px",
    outline: "none",
    transition: "border-color 0.15s",
  } satisfies React.CSSProperties,
  btn: {
    backgroundColor: "#7c3aed",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    padding: "12px 0",
    width: "100%",
    marginTop: 4,
    transition: "background 0.15s",
  } satisfies React.CSSProperties,
  btnSecondary: {
    backgroundColor: "transparent",
    color: "#7c3aed",
    border: "1px solid #7c3aed",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    padding: "10px 20px",
    cursor: "pointer",
    marginTop: 12,
  } satisfies React.CSSProperties,
  errorBanner: {
    backgroundColor: "#2a1515",
    border: "1px solid #4a2020",
    borderRadius: 6,
    color: "#f87171",
    fontSize: 13,
    padding: "10px 14px",
    marginBottom: 16,
    textAlign: "center" as const,
  } satisfies React.CSSProperties,
  hint: {
    color: "#555",
    fontSize: 13,
    marginTop: 8,
  } satisfies React.CSSProperties,
  link: {
    color: "#7c3aed",
    textDecoration: "underline",
  } satisfies React.CSSProperties,
};
