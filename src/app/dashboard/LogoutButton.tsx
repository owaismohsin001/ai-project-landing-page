"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={logout}
      disabled={loading}
      className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white transition hover:bg-white/5 disabled:opacity-60"
    >
      {loading ? "Signing out…" : "Log out"}
    </button>
  );
}
