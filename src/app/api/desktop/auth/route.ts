import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";

/**
 * GET /api/desktop/auth
 *
 * Called by the /desktop/auth page after the user is authenticated.
 * Returns the aiide:// deep-link URL the Electron app listens for.
 *
 * Responses:
 *   200 { workspaceUrl, redirectUrl }   — authenticated + workspace ready
 *   401 { error: "not_authenticated" }  — no valid session cookie
 *   404 { error: "no_workspace", status } — logged in but no workspace yet
 */
export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  await connectToDatabase();
  const user = await User.findById(session.sub).select(
    "workspaceStatus workspace name email"
  );
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  if (user.workspaceStatus !== "ready" || !user.workspace?.url) {
    return NextResponse.json(
      { error: "no_workspace", status: user.workspaceStatus ?? "none" },
      { status: 404 }
    );
  }

  const workspaceUrl = encodeURIComponent(user.workspace.url);
  const displayName = encodeURIComponent(user.name || user.email);

  return NextResponse.json({
    workspaceUrl: user.workspace.url,
    redirectUrl: `aiide://workspace?url=${workspaceUrl}&name=${displayName}`,
  });
}
