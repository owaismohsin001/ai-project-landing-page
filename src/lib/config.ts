/**
 * Central app configuration.
 *
 * The product name is a variable: set NEXT_PUBLIC_APP_NAME in your env to
 * rename the whole site. It defaults to "AI" when unset.
 */
export const APP_NAME: string = (process.env.NEXT_PUBLIC_APP_NAME || "AI").trim();

/** Public base URL — used for Stripe redirects and password-reset links. */
export const APP_URL: string = (
  process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
).replace(/\/$/, "");

export type PlanId = "starter" | "pro" | "premium";

export interface Plan {
  id: PlanId;
  name: string;
  /** Price in whole USD (charged once to unlock account creation). */
  price: number;
  tagline: string;
  features: string[];
  popular?: boolean;
}

/** The three paid membership plans. Enterprise is handled via the contact form. */
export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    price: 20,
    tagline: "For individuals exploring what's possible.",
    features: [
      "10,000 requests / month",
      "1 active project",
      "Standard AI models",
      "Community support",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: 60,
    tagline: "For builders shipping real products.",
    popular: true,
    features: [
      "100,000 requests / month",
      "10 active projects",
      "Standard + advanced models",
      "Usage analytics dashboard",
      "Priority email support",
    ],
  },
  premium: {
    id: "premium",
    name: "Premium",
    price: 200,
    tagline: "For teams operating at scale.",
    features: [
      "Unlimited requests",
      "Unlimited projects",
      "Advanced + experimental models",
      "Dedicated infrastructure",
      "24/7 priority support",
    ],
  },
};

export const PLAN_LIST: Plan[] = [PLANS.starter, PLANS.pro, PLANS.premium];

/** Extra perks listed on the Enterprise card (no fixed price). */
export const ENTERPRISE_FEATURES: string[] = [
  "Unlimited everything",
  "Custom models & SLAs",
  "SSO & advanced security",
  "Dedicated account team",
  "On-premise deployment option",
];

/** Runtime type guard for untrusted plan values coming from requests. */
export function isPlanId(value: unknown): value is PlanId {
  return value === "starter" || value === "pro" || value === "premium";
}

/** Stripe subscription statuses that currently grant access to the app. */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"];

/** True when a subscription status currently grants access. */
export function isSubscriptionActive(status?: string | null): boolean {
  return Boolean(status && ACTIVE_SUBSCRIPTION_STATUSES.includes(status));
}

/** Human-readable plan name for any stored plan id. */
export function planName(id: string): string {
  return isPlanId(id) ? PLANS[id].name : id;
}
