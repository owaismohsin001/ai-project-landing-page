import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { Purchase } from "@/models/Purchase";
import { User } from "@/models/User";
import {
  createSessionToken,
  hashPassword,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth";
import { isPlanId } from "@/lib/config";
import { provisionUserWorkspace, isAwsConfigured } from "@/lib/workspace";

/**
 * Creates an account — but only when backed by a completed, unused purchase.
 *
 * The email is taken from the Purchase record, not the request body, so a
 * user cannot register an address they did not pay with. After the account
 * exists, AWS workspace provisioning is kicked off in the background.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = String(body?.sessionId ?? "").trim();
    const name = String(body?.name ?? "").trim();
    const password = String(body?.password ?? "");

    if (!sessionId) {
      return NextResponse.json(
        { error: "Missing purchase reference. Please choose a plan first." },
        { status: 400 }
      );
    }
    if (name.length < 2) {
      return NextResponse.json(
        { error: "Please enter your name." },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 }
      );
    }

    await connectToDatabase();

    const purchase = await Purchase.findOne({ stripeSessionId: sessionId });
    if (!purchase || purchase.status !== "complete") {
      return NextResponse.json(
        { error: "No completed purchase found. Please choose a plan first." },
        { status: 402 }
      );
    }
    if (purchase.used) {
      return NextResponse.json(
        { error: "An account already exists for this purchase. Please log in." },
        { status: 409 }
      );
    }

    const existing = await User.findOne({ email: purchase.email });
    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists. Please log in." },
        { status: 409 }
      );
    }

    const user = await User.create({
      name,
      email: purchase.email,
      passwordHash: await hashPassword(password),
      plan: purchase.plan,
      stripeSessionId: sessionId,
      stripeCustomerId: purchase.stripeCustomerId,
      stripeSubscriptionId: purchase.stripeSubscriptionId,
      subscriptionStatus: purchase.subscriptionStatus || "active",
      workspaceStatus: isAwsConfigured() ? "provisioning" : "none",
    });

    // Consume the purchase so it cannot create a second account.
    purchase.used = true;
    await purchase.save();

    // Kick off AWS workspace provisioning in the background — don't block signup.
    if (isAwsConfigured() && isPlanId(user.plan)) {
      void provisionUserWorkspace(String(user._id), user.plan).catch((err) => {
        console.error("[signup] background provision error", err);
      });
    }

    const token = await createSessionToken({
      sub: String(user._id),
      email: user.email,
      name: user.name,
      plan: user.plan,
    });

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
    return res;
  } catch (err) {
    console.error("[signup]", err);
    return NextResponse.json(
      { error: "Could not create your account." },
      { status: 500 }
    );
  }
}
