/**
 * Creates a Stripe webhook endpoint via the API — it appears in the
 * Dashboard (Developers → Webhooks) just like one created by hand.
 *
 * Usage:
 *   node scripts/create-webhook.mjs https://your-domain.com
 *   npm run webhook:create -- https://your-domain.com
 *
 * The URL must be public HTTPS — Stripe delivers events to it directly, so
 * localhost will not work (use `npm run stripe:listen` for local testing).
 *
 * The signing secret is returned ONLY when the endpoint is created. Copy it
 * into your production environment as STRIPE_WEBHOOK_SECRET.
 */
import fs from "node:fs";
import Stripe from "stripe";

/** Read a key from .env.local so the Stripe secret key isn't passed on the CLI. */
function readEnv(key) {
  try {
    const file = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const line = file.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : "";
  } catch {
    return "";
  }
}

const input = process.argv[2];
if (!input || !input.startsWith("https://")) {
  console.error("Usage: node scripts/create-webhook.mjs https://your-domain.com");
  console.error("The URL must be a public HTTPS address (not localhost).");
  process.exit(1);
}

const key = process.env.STRIPE_SECRET_KEY || readEnv("STRIPE_SECRET_KEY");
if (!key) {
  console.error("STRIPE_SECRET_KEY not found in environment or .env.local.");
  process.exit(1);
}

const endpointUrl = `${input.replace(/\/$/, "")}/api/webhooks/stripe`;
const stripe = new Stripe(key);

try {
  const endpoint = await stripe.webhookEndpoints.create({
    url: endpointUrl,
    enabled_events: [
      "checkout.session.completed",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ],
    description: "AI landing page — membership subscriptions",
  });

  console.log("\n✅ Webhook endpoint created — visible in the Stripe Dashboard.\n");
  console.log(`  id:     ${endpoint.id}`);
  console.log(`  url:    ${endpoint.url}`);
  console.log(`  events: ${endpoint.enabled_events.join(", ")}`);
  console.log("\n  Signing secret (shown only once — copy it now):\n");
  console.log(`  STRIPE_WEBHOOK_SECRET=${endpoint.secret}\n`);
  console.log("Add that line to your production environment variables.\n");
} catch (err) {
  console.error("\n❌ Could not create the webhook endpoint:");
  console.error(`  ${err?.message ?? err}\n`);
  process.exit(1);
}
