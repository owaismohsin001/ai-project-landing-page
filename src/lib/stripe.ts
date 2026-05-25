import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;

if (!key) {
  // Surfaced lazily: the app still builds and the landing page still renders.
  console.warn(
    "[stripe] STRIPE_SECRET_KEY is not set — checkout will fail until it is configured."
  );
}

/**
 * Shared Stripe client. A placeholder key keeps construction from throwing at
 * import time; real API calls fail clearly until a valid key is provided.
 */
export const stripe = new Stripe(key || "sk_test_placeholder", {
  typescript: true,
});

/** True when a real Stripe key is configured. */
export const stripeEnabled = Boolean(key);
