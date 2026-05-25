import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { connectToDatabase } from "@/lib/db";
import { Purchase } from "@/models/Purchase";
import { isPlanId } from "@/lib/config";

/**
 * Verifies a Stripe Checkout session so the signup page can unlock.
 *
 * This reads the session straight from Stripe, so signup works in local
 * development even when the webhook has not been forwarded. It also creates
 * the Purchase record if it does not exist yet.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.json(
      { error: "Missing checkout session." },
      { status: 400 }
    );
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    if (session.status !== "complete") {
      return NextResponse.json(
        { error: "This checkout has not been completed." },
        { status: 402 }
      );
    }

    const email = session.customer_details?.email || session.customer_email;
    const plan = session.metadata?.plan;

    if (!email || !isPlanId(plan)) {
      return NextResponse.json(
        { error: "This checkout session is incomplete." },
        { status: 400 }
      );
    }

    const subscription =
      session.subscription && typeof session.subscription !== "string"
        ? (session.subscription as Stripe.Subscription)
        : null;
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id;

    await connectToDatabase();

    let purchase = await Purchase.findOne({ stripeSessionId: sessionId });
    if (!purchase) {
      purchase = await Purchase.create({
        stripeSessionId: sessionId,
        stripeSubscriptionId: subscription?.id,
        stripeCustomerId: customerId,
        email: email.toLowerCase(),
        plan,
        amount: (session.amount_total ?? 0) / 100,
        currency: session.currency ?? "usd",
        status: "complete",
        subscriptionStatus: subscription?.status ?? "active",
        used: false,
      });
    }

    if (purchase.used) {
      return NextResponse.json(
        { error: "An account has already been created for this purchase." },
        { status: 409 }
      );
    }

    return NextResponse.json({ email: purchase.email, plan: purchase.plan });
  } catch (err) {
    console.error("[checkout/verify]", err);
    return NextResponse.json(
      { error: "Could not verify your purchase." },
      { status: 500 }
    );
  }
}
