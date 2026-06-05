import { NextResponse } from "next/server";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import {
  EC2InstanceConnectClient,
  SendSSHPublicKeyCommand,
} from "@aws-sdk/client-ec2-instance-connect";
import {
  createDesktopToken,
  DESKTOP_TOKEN_TTL_SECONDS,
  verifyDesktopToken,
} from "@/lib/desktop-auth";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";

/**
 * POST /api/desktop/tunnel-grant
 *
 * Phase 6 — automated reverse SSH tunnel grant. Called by the desktop app
 * each time it (re)opens its tunnel to the user's EC2 workspace.
 *
 *   Headers:
 *     Authorization: Bearer <desktop JWT from /desktop/auth>
 *   Body:
 *     { sshPublicKey: string }    // OpenSSH-format public key
 *   Response:
 *     {
 *       ec2Ip:        string,     // user.workspace.publicIp
 *       ec2User:      "ubuntu",
 *       ec2Region:    string,     // from instance metadata (or fallback)
 *       expiresInSeconds: 60,     // EIC key validity
 *       refreshedToken: string    // new 30-day desktop JWT
 *     }
 *
 * Per-user authorization: the user's OWN AWS credentials (stored in their
 * Mongo User doc) are used to call ec2-instance-connect, so a desktop app
 * can only inject SSH keys into its own user's EC2. No platform-wide AWS
 * role required.
 */
export async function POST(req: Request) {
  try {
    // ── 1. Bearer auth ──────────────────────────────────────────────
    const auth = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!match) {
      return NextResponse.json(
        { error: "Missing Bearer token" },
        { status: 401 }
      );
    }
    const payload = await verifyDesktopToken(match[1]);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    // ── 2. Validate request body ────────────────────────────────────
    const body = (await req.json().catch(() => ({}))) as {
      sshPublicKey?: unknown;
    };
    const sshPublicKey = String(body.sshPublicKey ?? "");
    if (!sshPublicKey || !/^(ssh-(ed25519|rsa|ecdsa)|ecdsa-)/.test(sshPublicKey)) {
      return NextResponse.json(
        { error: "sshPublicKey must be an OpenSSH-format public key" },
        { status: 400 }
      );
    }

    // ── 3. Load user + workspace ────────────────────────────────────
    await connectToDatabase();
    const user = await User.findById(payload.sub);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const ws = user.workspace;
    if (
      !ws ||
      !ws.instanceId ||
      !ws.publicIp ||
      !ws.iamAccessKeyId ||
      !ws.iamSecretAccessKey
    ) {
      return NextResponse.json(
        { error: "User has no provisioned workspace" },
        { status: 409 }
      );
    }

    // ── 4. Resolve the instance's region using the user's own creds ──
    // Each per-user IAM credentials pair has access only to that user's
    // EC2 + S3 (terraform scopes the policy this way). We try AWS_REGION
    // first (typical), then fall back to checking the configured region
    // from env, then probe a few common regions until DescribeInstances
    // resolves. The user's instance lives in exactly one region; once
    // discovered we cache it on the User doc so subsequent grants skip
    // the probe.
    const credentials = {
      accessKeyId: ws.iamAccessKeyId,
      secretAccessKey: ws.iamSecretAccessKey,
    };
    const knownRegion =
      (user.workspace as unknown as { region?: string }).region ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      "us-west-2";

    let region = knownRegion;
    try {
      const ec2 = new EC2Client({ region, credentials });
      await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [ws.instanceId] })
      );
    } catch {
      // Fallback: try the typical regions. If we exhausted them, surface
      // an error to the client so the deploy issue is visible.
      const candidates = [
        "us-west-2", "us-east-1", "us-east-2", "us-west-1",
        "eu-west-1", "eu-west-2", "eu-central-1",
        "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
      ].filter((r) => r !== knownRegion);
      let resolved = false;
      for (const r of candidates) {
        try {
          const ec2 = new EC2Client({ region: r, credentials });
          await ec2.send(
            new DescribeInstancesCommand({ InstanceIds: [ws.instanceId] })
          );
          region = r;
          resolved = true;
          break;
        } catch {
          /* try next */
        }
      }
      if (!resolved) {
        return NextResponse.json(
          {
            error:
              "Could not locate the EC2 instance in any known region with the user's IAM creds.",
          },
          { status: 502 }
        );
      }
    }

    // ── 5. Send the SSH public key via EC2 Instance Connect ────────
    const eic = new EC2InstanceConnectClient({ region, credentials });
    const eicResult = await eic.send(
      new SendSSHPublicKeyCommand({
        InstanceId: ws.instanceId,
        InstanceOSUser: "ubuntu",
        SSHPublicKey: sshPublicKey,
      })
    );
    if (!eicResult.Success) {
      return NextResponse.json(
        { error: "EC2 Instance Connect refused the key push" },
        { status: 502 }
      );
    }

    // ── 6. Mint a refreshed token ──────────────────────────────────
    const refreshedToken = await createDesktopToken(String(user._id));

    // ── 7. Return everything the desktop needs ─────────────────────
    return NextResponse.json({
      ec2Ip: ws.publicIp,
      ec2User: "ubuntu",
      ec2Region: region,
      expiresInSeconds: 60,
      refreshedToken,
      tokenTtlSeconds: DESKTOP_TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    console.error("[tunnel-grant]", err);
    return NextResponse.json(
      { error: "Could not grant the tunnel." },
      { status: 500 }
    );
  }
}
