import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { APP_NAME, APP_URL, PLANS, isPlanId } from "@/lib/config";

/**
 * Starts a Stripe Checkout session for a monthly membership subscription.
 * On success the customer is sent to /signup to create their account.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const planId = body?.plan;

    if (!isPlanId(planId)) {
      return NextResponse.json(
        { error: "Please select a valid plan." },
        { status: 400 }
      );
    }

    const plan = PLANS[planId];

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: plan.price * 100,
            recurring: { interval: "month" },
            product_data: {
              name: `${APP_NAME} — ${plan.name} membership`,
            },
          },
        },
      ],
      metadata: { plan: planId },
      // Mirror the plan onto the subscription so webhook events carry it too.
      subscription_data: { metadata: { plan: planId } },
      success_url: `${APP_URL}/signup?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/?checkout=canceled#pricing`,
    });

    if (!session.url) {
      return NextResponse.json(
        { error: "Could not start checkout." },
        { status: 500 }
      );
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[checkout]", err);
    return NextResponse.json(
      { error: "Checkout is unavailable. Confirm Stripe keys are configured." },
      { status: 500 }
    );
  }
}
