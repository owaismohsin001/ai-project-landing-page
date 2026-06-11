import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import {
  loginServer,
  mintAuthKey,
  deleteOfflineNodesByName,
  sanitizeNode,
  desktopHostname,
  workspaceHostname,
  MAGIC_DNS_SUFFIX,
} from "@/lib/headscale";

/**
 * POST /api/workspace/mesh-authkey
 *
 * Server-to-server endpoint called by a user's EC2 workspace during
 * provisioning (terraform/workspace/provision.sh) to obtain an ephemeral
 * Headscale pre-auth key so the box can join the user's tailnet.
 *
 *   Body: { userId: string, provisionSecret: string }
 *   Response:
 *     {
 *       loginServer:     string,   // https://headscale.platform...
 *       authKey:         string,   // ephemeral, single-use, tag:workspace-<node>
 *       desktopHostname: string,   // desktop-<node> (the MCP peer to reach)
 *       magicDnsSuffix:  string    // ts.platform...
 *     }
 *
 * Auth is a shared `WORKSPACE_PROVISION_SECRET` (templated into the EC2's
 * /etc/workspace.env by terraform). This is a trusted server-to-server call,
 * not a browser-facing one.
 */
export async function POST(req: Request) {
  try {
    const expected = process.env.WORKSPACE_PROVISION_SECRET;
    if (!expected) {
      return NextResponse.json(
        { error: "Provisioning is not configured on this server." },
        { status: 503 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      userId?: unknown;
      provisionSecret?: unknown;
    };
    const userId = String(body.userId ?? "");
    const provisionSecret = String(body.provisionSecret ?? "");

    if (!provisionSecret || provisionSecret !== expected) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    // Confirm the user actually owns a workspace before handing out a key.
    await connectToDatabase();
    const user = await User.findById(userId).select("workspace");
    if (!user || !user.workspace || !user.workspace.instanceId) {
      return NextResponse.json(
        { error: "No provisioned workspace for that user" },
        { status: 404 }
      );
    }

    // Prune any stale registration of this workspace hostname first. A fresh
    // EC2 (rebuild) gets a new machine key, so the previous instance's node is
    // dead weight; removing the offline one keeps a single live workspace node.
    const node = sanitizeNode(userId);
    await deleteOfflineNodesByName(workspaceHostname(node));
    const authKey = await mintAuthKey({ node });

    return NextResponse.json({
      loginServer: loginServer(),
      authKey,
      desktopHostname: desktopHostname(node),
      magicDnsSuffix: MAGIC_DNS_SUFFIX,
    });
  } catch (err) {
    console.error("[mesh-authkey]", err);
    return NextResponse.json(
      { error: "Could not mint workspace mesh key." },
      { status: 500 }
    );
  }
}
