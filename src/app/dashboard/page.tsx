import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import {
  APP_NAME,
  isSubscriptionActive,
  PLANS,
  planName,
  isPlanId,
} from "@/lib/config";
import { stripe, stripeEnabled } from "@/lib/stripe";
import { ManageBillingButton } from "./ManageBillingButton";
import { WorkspaceCard } from "./WorkspaceCard";
import { GreetingHeader } from "./GreetingHeader";
import { UserMenu } from "./UserMenu";
import { WorkspaceCTA } from "./WorkspaceCTA";
import { ThemeToggle } from "@/components/ThemeToggle";

interface BillingInfo {
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  priceAmount: number | null;
  priceInterval: string;
  status: string;
}

/**
 * Authenticated area. Redirects to /login without a session; the member
 * content is gated on a live, active subscription read from the database.
 */
export default async function DashboardPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");

  await connectToDatabase();
  const user = await User.findById(session.sub);
  if (!user) redirect("/login");

  const active = isSubscriptionActive(user.subscriptionStatus);
  const billing = active ? await fetchBilling(user.stripeSubscriptionId) : null;

  const initials = (user.name || user.email || "?")
    .split(/\s+/)
    .map((p: string) => p.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Initial state for the workspace card (it polls /api/workspace after).
  const initialWorkspace = {
    status: user.workspaceStatus ?? "none",
    error: user.workspaceError ?? null,
    workspace: user.workspace
      ? {
          instanceId: user.workspace.instanceId,
          publicIp: user.workspace.publicIp,
          publicDns: user.workspace.publicDns,
          bucketName: user.workspace.bucketName,
          iamAccessKeyId: user.workspace.iamAccessKeyId,
          url: user.workspace.url,
        }
      : null,
  };

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Ambient background glow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[800px] -translate-x-1/2 rounded-full bg-brand-500/10 blur-3xl dark:bg-brand-600/10"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-20 right-0 h-[300px] w-[400px] rounded-full bg-purple-500/[0.06] blur-3xl dark:bg-purple-600/[0.07]"
      />

      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur-md dark:border-white/5 dark:bg-ink-900/70">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
          <span className="flex items-center gap-2.5 font-semibold text-slate-900 dark:text-white">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white shadow-lg shadow-brand-600/30">
              {APP_NAME.charAt(0).toUpperCase()}
            </span>
            <span className="hidden sm:inline">{APP_NAME}</span>
          </span>

          <nav className="hidden items-center gap-1 md:flex">
            <NavLink href="/dashboard" active>
              Dashboard
            </NavLink>
            <NavLink href="/dashboard">Projects</NavLink>
            <NavLink href="/dashboard">Activity</NavLink>
            <NavLink href="/dashboard">Docs</NavLink>
          </nav>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <UserMenu
              name={user.name}
              email={user.email}
              initials={initials}
            />
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <GreetingHeader name={user.name} />
          </div>
          <WorkspaceCTA
            initialStatus={initialWorkspace.status}
            initialUrl={initialWorkspace.workspace?.url ?? null}
          />
        </div>

        {active ? (
          <>
            {/* Subscription banner — full width, the focal point of the page. */}
            <div className="mt-8">
              <SubscriptionCard
                planId={user.plan}
                status={user.subscriptionStatus}
                billing={billing}
              />
            </div>

            {/* Smaller usage stat cards. */}
            <div className="mt-6 grid gap-5 sm:grid-cols-3">
              <StatCard
                label="API requests"
                value="0"
                caption="No traffic yet"
                tone="blue"
                trend="—"
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                    aria-hidden
                  >
                    <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                }
              />
              <StatCard
                label="Projects"
                value="0"
                caption="Create your first one"
                tone="purple"
                trend="—"
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                    aria-hidden
                  >
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                  </svg>
                }
              />
              <StatCard
                label="Member since"
                value={formatMonth(user.createdAt)}
                caption={`${daysSince(user.createdAt)} days with us`}
                tone="amber"
                trend=""
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                    aria-hidden
                  >
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                }
              />
            </div>

            {/* Workspace section. */}
            <section id="workspace-section" className="mt-10 scroll-mt-24">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Your workspace
                </h2>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Dedicated cloud environment
                </p>
              </div>
              <WorkspaceCard initial={initialWorkspace} />
            </section>
          </>
        ) : (
          <div className="mt-10 rounded-2xl border border-amber-300 bg-amber-50 p-8 dark:border-amber-500/30 dark:bg-amber-500/10">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              Your membership is inactive
            </h2>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
              Your {planName(user.plan)} subscription is currently{" "}
              <span className="font-medium text-amber-700 dark:text-amber-300">
                {user.subscriptionStatus}
              </span>
              . Reactivate it to restore access to member features.
            </p>
            <div className="mt-5">
              <ManageBillingButton
                variant="primary"
                label="Reactivate membership"
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function fetchBilling(
  subscriptionId?: string
): Promise<BillingInfo | null> {
  if (!subscriptionId || !stripeEnabled) return null;
  try {
    // Cast through unknown — Stripe's TS types lag behind the API where
    // period dates have shifted between subscription and item level.
    const sub = (await stripe.subscriptions.retrieve(
      subscriptionId
    )) as unknown as {
      status: string;
      current_period_start: number;
      current_period_end: number;
      cancel_at_period_end: boolean;
      items: {
        data: Array<{
          current_period_start?: number;
          current_period_end?: number;
          price?: {
            unit_amount: number | null;
            recurring?: { interval: string };
          };
        }>;
      };
    };
    const item = sub.items.data[0];
    return {
      status: sub.status,
      periodStart:
        (item?.current_period_start ?? sub.current_period_start) * 1000,
      periodEnd: (item?.current_period_end ?? sub.current_period_end) * 1000,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      priceAmount: item?.price?.unit_amount ?? null,
      priceInterval: item?.price?.recurring?.interval ?? "month",
    };
  } catch {
    return null;
  }
}

function formatMonth(d: Date | string): string {
  const date = new Date(d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

function formatFullDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function daysSince(d: Date | string): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000)
  );
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.ceil((toMs - fromMs) / 86_400_000));
}

// ─── NavLink ──────────────────────────────────────────────────────────

function NavLink({
  href,
  children,
  active = false,
}: {
  href: string;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <a
      href={href}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-slate-100 text-slate-900 dark:bg-white/[0.06] dark:text-white"
          : "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.04] dark:hover:text-slate-200"
      }`}
    >
      {children}
    </a>
  );
}

// ─── SubscriptionCard ─────────────────────────────────────────────────

function SubscriptionCard({
  planId,
  status,
  billing,
}: {
  planId: string;
  status: string;
  billing: BillingInfo | null;
}) {
  const planLabel = planName(planId);
  // Local fallback price when Stripe data isn't available (offline / no key).
  const price = billing?.priceAmount
    ? billing.priceAmount / 100
    : isPlanId(planId)
      ? PLANS[planId].price
      : null;
  const interval = billing?.priceInterval || "month";
  const now = Date.now();
  const daysLeft = billing ? daysBetween(now, billing.periodEnd) : null;
  const cycleDays = billing
    ? daysBetween(billing.periodStart, billing.periodEnd) || 30
    : 30;
  const cyclePct = billing
    ? Math.min(
        100,
        Math.max(
          0,
          ((now - billing.periodStart) /
            (billing.periodEnd - billing.periodStart)) *
            100
        )
      )
    : 0;

  // Color the "days left" tone based on urgency.
  const urgency: "ok" | "warn" | "danger" =
    daysLeft === null
      ? "ok"
      : daysLeft <= 3
        ? "danger"
        : daysLeft <= 7
          ? "warn"
          : "ok";
  const urgencyText = {
    ok: "text-emerald-700 dark:text-emerald-300",
    warn: "text-amber-700 dark:text-amber-300",
    danger: "text-rose-700 dark:text-rose-300",
  }[urgency];
  const urgencyBg = {
    ok: "from-emerald-500 to-emerald-400",
    warn: "from-amber-500 to-amber-400",
    danger: "from-rose-500 to-rose-400",
  }[urgency];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-brand-200 bg-gradient-to-br from-white to-brand-50/60 p-6 shadow-lg shadow-brand-500/[0.05] dark:border-brand-500/20 dark:from-ink-800 dark:to-brand-900/30 dark:shadow-xl dark:shadow-black/20">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-brand-500/10 blur-3xl"
      />

      <div className="relative flex flex-wrap items-start justify-between gap-6">
        {/* Left side: plan name + status */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.7)] dark:bg-emerald-400" />
              {status}
            </span>
            {billing?.cancelAtPeriodEnd && (
              <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                Cancels at period end
              </span>
            )}
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
              {planLabel}
              <span className="text-slate-500 dark:text-slate-400"> Plan</span>
            </h2>
            {price !== null && (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  ${price}
                </span>
                {" / "}
                {interval}
              </p>
            )}
          </div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            {isPlanId(planId)
              ? PLANS[planId].tagline
              : "Your active membership."}
          </p>
        </div>

        {/* Right side: renewal info */}
        <div className="flex-shrink-0">
          <ManageBillingButton />
        </div>
      </div>

      {/* Billing cycle progress */}
      {billing && (
        <div className="relative mt-6">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500 dark:text-slate-400">
              Current cycle started{" "}
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {formatFullDate(billing.periodStart)}
              </span>
            </span>
            <span className={`font-semibold ${urgencyText}`}>
              {daysLeft} days remaining
            </span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200 ring-1 ring-inset ring-slate-200 dark:bg-white/5 dark:ring-white/5">
            <div
              className={`h-full rounded-full bg-gradient-to-r transition-all ${urgencyBg}`}
              style={{ width: `${cyclePct}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {billing.cancelAtPeriodEnd ? "Ends" : "Renews"} on{" "}
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {formatFullDate(billing.periodEnd)}
            </span>{" "}
            · day {Math.max(1, cycleDays - (daysLeft ?? 0))} of {cycleDays}
          </p>
        </div>
      )}

      {/* When Stripe data isn't reachable, still show static plan price. */}
      {!billing && (
        <p className="mt-6 text-xs text-slate-500">
          Live billing details unavailable — open the billing portal to view
          your renewal date.
        </p>
      )}
    </div>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────

const STAT_TONES = {
  emerald: {
    border:
      "border-emerald-200 hover:border-emerald-300 dark:border-emerald-500/15 dark:hover:border-emerald-500/30",
    glow: "from-emerald-500/[0.05] dark:from-emerald-500/[0.08]",
    iconWrap:
      "bg-emerald-100 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20",
    caption: "text-emerald-700 dark:text-emerald-300",
  },
  blue: {
    border:
      "border-blue-200 hover:border-blue-300 dark:border-blue-500/15 dark:hover:border-blue-500/30",
    glow: "from-blue-500/[0.05] dark:from-blue-500/[0.08]",
    iconWrap:
      "bg-blue-100 text-blue-700 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/20",
    caption: "text-blue-700 dark:text-blue-300",
  },
  purple: {
    border:
      "border-purple-200 hover:border-purple-300 dark:border-purple-500/15 dark:hover:border-purple-500/30",
    glow: "from-purple-500/[0.05] dark:from-purple-500/[0.08]",
    iconWrap:
      "bg-purple-100 text-purple-700 ring-purple-200 dark:bg-purple-500/10 dark:text-purple-300 dark:ring-purple-500/20",
    caption: "text-purple-700 dark:text-purple-300",
  },
  amber: {
    border:
      "border-amber-200 hover:border-amber-300 dark:border-amber-500/15 dark:hover:border-amber-500/30",
    glow: "from-amber-500/[0.05] dark:from-amber-500/[0.08]",
    iconWrap:
      "bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
    caption: "text-amber-700 dark:text-amber-300",
  },
} as const;

type StatTone = keyof typeof STAT_TONES;

function StatCard({
  label,
  value,
  caption,
  tone,
  icon,
  trend,
}: {
  label: string;
  value: string;
  caption?: string;
  tone: StatTone;
  icon: React.ReactNode;
  trend?: string;
}) {
  const t = STAT_TONES[tone];
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border bg-white p-6 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-900/[0.06] dark:bg-ink-800 dark:hover:shadow-black/30 ${t.border}`}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 -top-px h-24 bg-gradient-to-b to-transparent ${t.glow}`}
      />
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
          <p className="mt-1 truncate text-2xl font-bold text-slate-900 dark:text-white">
            {value}
          </p>
          {caption && (
            <p className={`mt-1 text-xs font-medium ${t.caption}`}>{caption}</p>
          )}
        </div>
        <div
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ring-1 transition group-hover:scale-105 ${t.iconWrap}`}
        >
          {icon}
        </div>
      </div>
      {trend && trend !== "" && trend !== "—" && (
        <p className="relative mt-4 text-xs text-slate-500">{trend}</p>
      )}
    </div>
  );
}
