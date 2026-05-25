import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { connectToDatabase } from "@/lib/db";
import { Purchase, type IPurchase } from "@/models/Purchase";
import { User } from "@/models/User";
import { destroyUserWorkspace } from "@/lib/workspace";

/**
 * Stripe webhook — the authoritative source of subscription state.
 *
 *   checkout.session.completed    → record the purchase that unlocks signup
 *   customer.subscription.updated → keep the member's access status current
 *   customer.subscription.deleted → revoke access + tear down their workspace
 *
 * Locally, forward events with:
 *   stripe listen --forward-to localhost:3000/api/webhooks/stripe
 */
export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return NextResponse.json(
      { error: "Webhook is not configured." },
      { status: 400 }
    );
  }

  // Stripe signature verification needs the raw request body.
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch (err) {
    console.error("[webhook] signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    await connectToDatabase();

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const email = session.customer_details?.email || session.customer_email;
        const plan = session.metadata?.plan;

        if (session.status === "complete" && email && plan) {
          const insert: Partial<IPurchase> = {
            stripeSessionId: session.id,
            email: email.toLowerCase(),
            plan,
            amount: (session.amount_total ?? 0) / 100,
            currency: session.currency ?? "usd",
            status: "complete",
            subscriptionStatus: "active",
            used: false,
          };
          if (typeof session.subscription === "string") {
            insert.stripeSubscriptionId = session.subscription;
          }
          if (typeof session.customer === "string") {
            insert.stripeCustomerId = session.customer;
          }
          // Upsert so a verify call that already created the row is kept.
          await Purchase.updateOne(
            { stripeSessionId: session.id },
            { $setOnInsert: insert },
            { upsert: true }
          );
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        // Keep the member's access in sync — this is what revokes access
        // when a payment fails or is paused.
        await User.updateOne(
          { stripeSubscriptionId: subscription.id },
          { $set: { subscriptionStatus: subscription.status } }
        );
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        // Flip the user to canceled AND tear down their workspace.
        const user = await User.findOneAndUpdate(
          { stripeSubscriptionId: subscription.id },
          { $set: { subscriptionStatus: "canceled" } },
          { new: true }
        );
        if (user) {
          void destroyUserWorkspace(String(user._id)).catch((err) => {
            console.error("[webhook] background destroy error", err);
          });
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("[webhook] handler error", err);
    // 500 tells Stripe to retry delivery.
    return NextResponse.json({ error: "Database error." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
