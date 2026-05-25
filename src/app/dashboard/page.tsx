import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { APP_NAME, isSubscriptionActive, planName } from "@/lib/config";
import { LogoutButton } from "./LogoutButton";
import { ManageBillingButton } from "./ManageBillingButton";
import { WorkspaceCard } from "./WorkspaceCard";

/**
 * Authenticated area. Redirects to /login without a session; the member
 * content is gated on a live, active subscription read from the database.
 */
export default async function DashboardPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");

  await connectToDatabase();
  const user = await User.findById(session.sub);
  if (!user) redirect("/login");

  const active = isSubscriptionActive(user.subscriptionStatus);

  // Initial state for the workspace card (it polls /api/workspace after).
  const initialWorkspace = {
    status: user.workspaceStatus ?? "none",
    error: user.workspaceError ?? null,
    workspace: user.workspace
      ? {
          instanceId: user.workspace.instanceId,
          publicIp: user.workspace.publicIp,
          publicDns: user.workspace.publicDns,
          bucketName: user.workspace.bucketName,
          iamAccessKeyId: user.workspace.iamAccessKeyId,
          url: user.workspace.url,
        }
      : null,
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-white/5 bg-ink-900">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <span className="flex items-center gap-2 font-semibold text-white">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
              {APP_NAME.charAt(0).toUpperCase()}
            </span>
            {APP_NAME}
          </span>
          <div className="flex items-center gap-3">
            <ManageBillingButton />
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16">
        <p className="text-sm font-medium text-brand-400">Dashboard</p>
        <h1 className="mt-1 text-3xl font-bold text-white">
          Welcome, {user.name} 👋
        </h1>
        <p className="mt-2 text-slate-400">{user.email}</p>

        {active ? (
          <>
            <div className="mt-10 grid gap-6 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/5 bg-ink-800 p-6">
                <p className="text-sm text-slate-400">Membership</p>
                <p className="mt-1 text-2xl font-bold text-white">
                  {planName(user.plan)}
                </p>
                <p className="mt-1 text-xs font-medium text-emerald-400">
                  Active · billed monthly
                </p>
              </div>
              <div className="rounded-2xl border border-white/5 bg-ink-800 p-6">
                <p className="text-sm text-slate-400">API requests</p>
                <p className="mt-1 text-2xl font-bold text-white">0</p>
              </div>
              <div className="rounded-2xl border border-white/5 bg-ink-800 p-6">
                <p className="text-sm text-slate-400">Projects</p>
                <p className="mt-1 text-2xl font-bold text-white">0</p>
              </div>
            </div>

            <div className="mt-8">
              <WorkspaceCard initial={initialWorkspace} />
            </div>
          </>
        ) : (
          <div className="mt-10 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-8">
            <h2 className="text-lg font-semibold text-white">
              Your membership is inactive
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Your {planName(user.plan)} subscription is currently{" "}
              <span className="font-medium text-amber-300">
                {user.subscriptionStatus}
              </span>
              . Reactivate it to restore access to member features.
            </p>
            <div className="mt-5">
              <ManageBillingButton
                variant="primary"
                label="Reactivate membership"
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
