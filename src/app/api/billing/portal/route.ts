import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { getSessionUser } from "@/lib/auth";
import { APP_URL } from "@/lib/config";

/**
 * Creates a Stripe Billing Portal session so members can update their card,
 * switch plan, or cancel.
 *
 * The portal must be enabled once in the Stripe Dashboard:
 *   Settings → Billing → Customer portal.
 */
export async function POST() {
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json(
        { error: "You are not signed in." },
        { status: 401 }
      );
    }

    await connectToDatabase();
    const user = await User.findById(sessionUser.sub);
    if (!user?.stripeCustomerId) {
      return NextResponse.json(
        { error: "No billing account is linked to this user." },
        { status: 400 }
      );
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${APP_URL}/dashboard`,
    });

    return NextResponse.json({ url: portal.url });
  } catch (err) {
    console.error("[billing/portal]", err);
    return NextResponse.json(
      { error: "Could not open the billing portal." },
      { status: 500 }
    );
  }
}
