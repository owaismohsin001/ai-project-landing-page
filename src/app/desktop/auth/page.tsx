import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { createDesktopToken } from "@/lib/desktop-auth";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { AuthLayout } from "@/components/AuthLayout";
import { primaryButtonClass } from "@/components/ui";

const RETURN_PATH = "/desktop/auth";

export const dynamic = "force-dynamic";

export default async function DesktopAuthPage() {
  const session = await getSessionUser();
  if (!session) {
    redirect(`/login?returnTo=${encodeURIComponent(RETURN_PATH)}`);
  }

  await connectToDatabase();
  const user = await User.findById(session.sub);
  if (!user) {
    redirect(`/login?returnTo=${encodeURIComponent(RETURN_PATH)}`);
  }

  const workspaceUrl = user.workspace?.url;
  const workspaceReady =
    user.workspaceStatus === "ready" && typeof workspaceUrl === "string" && workspaceUrl.length > 0;

  if (!workspaceReady) {
    return (
      <AuthLayout
        title="Workspace not ready"
        subtitle={
          user.workspaceStatus === "provisioning"
            ? "Your workspace is still being provisioned. Come back here once the dashboard shows it as ready."
            : "We couldn't find a ready workspace on your account."
        }
      >
        <div className="space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <p>Open the dashboard to check status or kick off provisioning.</p>
          <Link href="/dashboard" className={primaryButtonClass}>
            Go to dashboard
          </Link>
        </div>
      </AuthLayout>
    );
  }

  // Mint the 30-day desktop bearer token (Phase 6). Embedded in the
  // aiide:// deep link so the Electron app stores it on first launch and
  // uses it to call /api/desktop/mesh-grant. The token is refreshed
  // by the grant endpoint each time it's used, so active users stay
  // connected indefinitely.
  const desktopToken = await createDesktopToken(String(user._id));

  // The desktop app also needs to know which platform host to hit for the
  // grant endpoint. Derive from the current request so localhost dev and
  // production both Just Work without hard-coding.
  const reqHeaders = await headers();
  const proto = reqHeaders.get("x-forwarded-proto") ?? "http";
  const host = reqHeaders.get("host") ?? "platform.example.com";
  const platformUrl = `${proto}://${host}`;

  const aiideUrl =
    `aiide://workspace?url=${encodeURIComponent(workspaceUrl!)}` +
    `&name=${encodeURIComponent(user.name || user.email)}` +
    `&token=${encodeURIComponent(desktopToken)}` +
    `&platformUrl=${encodeURIComponent(platformUrl)}`;

  return (
    <AuthLayout
      title="Opening AI IDE Studio…"
      subtitle="If the desktop app didn't launch automatically, use the button below."
    >
      <div className="space-y-4 text-sm text-slate-700 dark:text-slate-300">
        <p>
          Signed in as <strong>{user.email}</strong>. Connecting to{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-800 dark:bg-white/5 dark:text-slate-200">
            {workspaceUrl}
          </code>
          .
        </p>
        <a href={aiideUrl} className={primaryButtonClass}>
          Open AI IDE Studio
        </a>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          You can close this tab once the app opens.
        </p>
      </div>

      {/* Trigger the custom-scheme handoff as soon as the page paints. The
          fallback button above stays clickable in case the OS prompt is
          dismissed or the protocol isn't registered yet. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `window.location.replace(${JSON.stringify(aiideUrl)});`,
        }}
      />
    </AuthLayout>
  );
}
