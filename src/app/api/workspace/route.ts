import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { getSessionUser } from "@/lib/auth";
import { isPlanId, isSubscriptionActive } from "@/lib/config";
import {
  destroyUserWorkspace,
  isAwsConfigured,
  provisionUserWorkspace,
} from "@/lib/workspace";

/**
 * GET — Returns the current user's workspace status. Used by the dashboard
 * to poll while provisioning is in flight.
 *
 * The IAM **secret access key** is intentionally NOT returned — only fields
 * safe to expose to the browser.
 */
export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  await connectToDatabase();
  const user = await User.findById(session.sub).select(
    "workspaceStatus workspaceError workspace"
  );
  if (!user) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const workspace = user.workspace
    ? {
        instanceId: user.workspace.instanceId,
        publicIp: user.workspace.publicIp,
        publicDns: user.workspace.publicDns,
        bucketName: user.workspace.bucketName,
        iamAccessKeyId: user.workspace.iamAccessKeyId,
        url: user.workspace.url,
      }
    : null;

  return NextResponse.json({
    status: user.workspaceStatus ?? "none",
    error: user.workspaceError ?? null,
    workspace,
  });
}

/**
 * POST — Starts provisioning the current user's workspace if it doesn't
 * already exist. Idempotent: returns the current status when a workspace is
 * already ready or in-flight, instead of starting a second apply.
 */
export async function POST() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  await connectToDatabase();
  const user = await User.findById(session.sub);
  if (!user) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (!isSubscriptionActive(user.subscriptionStatus)) {
    return NextResponse.json(
      { error: "Your subscription is not active." },
      { status: 402 }
    );
  }

  // Idempotent paths — don't trigger a second provision.
  if (user.workspaceStatus === "ready") {
    return NextResponse.json({ status: "ready" });
  }
  if (user.workspaceStatus === "provisioning") {
    return NextResponse.json({ status: "provisioning" }, { status: 202 });
  }
  if (user.workspaceStatus === "destroying") {
    return NextResponse.json(
      { error: "Workspace is being torn down — try again in a moment." },
      { status: 409 }
    );
  }

  if (!isAwsConfigured()) {
    return NextResponse.json(
      { error: "AWS provisioning is not configured on this server." },
      { status: 503 }
    );
  }
  if (!isPlanId(user.plan)) {
    return NextResponse.json(
      { error: "Unknown plan on this account." },
      { status: 400 }
    );
  }

  // Flip to "provisioning" immediately so the dashboard reflects it on the
  // very next poll, even before terraform has done anything.
  await User.updateOne(
    { _id: user._id },
    {
      $set: { workspaceStatus: "provisioning" },
      $unset: { workspaceError: "" },
    }
  );

  // Fire-and-forget — provisioning takes several minutes; we don't block.
  void provisionUserWorkspace(String(user._id), user.plan).catch((err) => {
    console.error("[api/workspace POST] background provision error", err);
  });

  return NextResponse.json({ status: "provisioning" }, { status: 202 });
}

/**
 * DELETE — Tears down the current user's workspace. Idempotent: returns the
 * current status when nothing is provisioned, already being destroyed, or
 * already destroyed. Refuses to destroy mid-provision.
 */
export async function DELETE() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  await connectToDatabase();
  const user = await User.findById(session.sub);
  if (!user) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Nothing to destroy.
  if (
    !user.workspaceStatus ||
    user.workspaceStatus === "none" ||
    user.workspaceStatus === "destroyed"
  ) {
    return NextResponse.json({ status: "destroyed" });
  }
  if (user.workspaceStatus === "destroying") {
    return NextResponse.json({ status: "destroying" }, { status: 202 });
  }
  if (user.workspaceStatus === "provisioning") {
    return NextResponse.json(
      {
        error:
          "Workspace is still being created. Wait until it's ready, then destroy.",
      },
      { status: 409 }
    );
  }

  if (!isAwsConfigured()) {
    return NextResponse.json(
      { error: "AWS provisioning is not configured on this server." },
      { status: 503 }
    );
  }

  // Flip to "destroying" synchronously so the UI reflects it on the next poll.
  await User.updateOne(
    { _id: user._id },
    {
      $set: { workspaceStatus: "destroying" },
      $unset: { workspaceError: "" },
    }
  );

  // Fire-and-forget — terraform destroy takes a couple of minutes.
  void destroyUserWorkspace(String(user._id)).catch((err) => {
    console.error("[api/workspace DELETE] background destroy error", err);
  });

  return NextResponse.json({ status: "destroying" }, { status: 202 });
}
