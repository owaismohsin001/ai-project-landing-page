import { NextResponse } from "next/server";
import {
  createDesktopToken,
  DESKTOP_TOKEN_TTL_SECONDS,
  verifyDesktopToken,
} from "@/lib/desktop-auth";
import {
  loginServer,
  mintAuthKey,
  deleteOfflineNodesByName,
  sanitizeNode,
  desktopHostname,
  MAGIC_DNS_SUFFIX,
} from "@/lib/headscale";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";

/**
 * POST /api/desktop/mesh-grant
 *
 * Mesh replacement for the old reverse-SSH `tunnel-grant`. Called by the
 * desktop app each time it (re)joins the user's Headscale tailnet.
 *
 *   Headers:
 *     Authorization: Bearer <desktop JWT from /desktop/auth>
 *   Response:
 *     {
 *       loginServer:     string,   // https://headscale.platform...
 *       authKey:         string,   // ephemeral, single-use, tag:desktop-<node>
 *       desktopHostname: string,   // desktop-<node>
 *       magicDnsSuffix:  string,   // ts.platform...
 *       refreshedToken:  string,   // new 30-day desktop JWT
 *       tokenTtlSeconds: number
 *     }
 *
 * The desktop then runs `tailscale up --login-server=<loginServer>
 * --authkey=<authKey> --hostname=<desktopHostname>` and exposes its local
 * Playwright MCP port to the tailnet. The user's EC2 workspace reaches it at
 * http://<desktopHostname>.<magicDnsSuffix>:9090/ over MagicDNS.
 */
export async function POST(req: Request) {
  try {
    // ── 1. Bearer auth ──────────────────────────────────────────────
    const auth = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!match) {
      return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });
    }
    const payload = await verifyDesktopToken(match[1]);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    // ── 2. Load user + confirm a workspace exists ───────────────────
    await connectToDatabase();
    const user = await User.findById(payload.sub);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (!user.workspace || !user.workspace.instanceId) {
      return NextResponse.json(
        { error: "User has no provisioned workspace" },
        { status: 409 }
      );
    }

    // ── 3. Mint a persistent pre-auth key for the desktop node ──────
    // Prune any stale offline registration of this desktop first (e.g. after an
    // app reinstall) so we don't accumulate duplicates; the live node, if any,
    // is left alone and reused via its persisted machine key.
    const node = sanitizeNode(String(user._id));
    await deleteOfflineNodesByName(desktopHostname(node));
    const authKey = await mintAuthKey({ node });

    // ── 4. Refresh the desktop token ────────────────────────────────
    const refreshedToken = await createDesktopToken(String(user._id));

    return NextResponse.json({
      loginServer: loginServer(),
      authKey,
      desktopHostname: desktopHostname(node),
      magicDnsSuffix: MAGIC_DNS_SUFFIX,
      refreshedToken,
      tokenTtlSeconds: DESKTOP_TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    console.error("[mesh-grant]", err);
    return NextResponse.json(
      { error: "Could not grant mesh access." },
      { status: 500 }
    );
  }
}
