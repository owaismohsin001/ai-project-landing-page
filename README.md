# AI — Landing Page + Membership Auth

A Next.js (App Router, TypeScript) app with a blue/black theme: a landing
page, three paid membership plans plus an Enterprise contact form, and a full
auth flow where **users can only sign up after buying a membership**.

The product name is a variable — set `NEXT_PUBLIC_APP_NAME` to rename the
entire site (defaults to `AI`).

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript**
- **MongoDB** via **Mongoose**
- **Stripe Checkout** for payments + webhooks
- **Tailwind CSS** for styling
- Sessions: signed JWT (`jose`) in an httpOnly cookie; passwords hashed with `bcryptjs`

## How the signup gate works

1. Visitor picks a plan on the landing page → **Stripe Checkout**.
2. After payment, Stripe redirects to `/signup?session_id=...`.
3. `/signup` verifies the session with Stripe and records a paid **Purchase**.
4. The signup form unlocks; the email is taken from the purchase and locked.
5. Creating the account marks the purchase **used** so it can't be reused.
6. The Stripe **webhook** (`checkout.session.completed`) is the authoritative
   backup record of every payment.

Enterprise has no fixed price — its card links to `/contact`, a form that is
stored in MongoDB and emailed to sales.

## Pages

| Route | Purpose |
|---|---|
| `/` | Landing page — hero, features, pricing |
| `/login` | Log in |
| `/signup` | Create account (requires a paid Stripe session) |
| `/forgot-password` | Request a password-reset link |
| `/reset-password` | Set a new password from the emailed link |
| `/contact` | Enterprise sales enquiry form |
| `/dashboard` | Authenticated area (redirects to `/login` if signed out) |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

`.env.local` is created for you with a generated `JWT_SECRET`. Fill in the
rest (see `.env.example` for documentation):

- **`MONGODB_URI`** — local MongoDB or a MongoDB Atlas connection string.
- **`STRIPE_SECRET_KEY`** — test key from <https://dashboard.stripe.com/test/apikeys>.
- **`STRIPE_WEBHOOK_SECRET`** — see step 4.
- **`NEXT_PUBLIC_APP_NAME`** — the product name (defaults to `AI`).

### 3. Run

```bash
npm run dev
```

Open <http://localhost:3000>.

### 4. Stripe webhook (local)

In a separate terminal, with the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Copy the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.

> Signup also verifies the session directly with Stripe, so it works locally
> even without the webhook running. The webhook is the reliable record for
> production.

Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

## Notes

- **Email** (password-reset + sales notifications) is logged to the server
  console by default — no provider is wired up. Plug Resend/SendGrid/nodemailer
  into `src/lib/email.ts` to send real email.
- Plans are **monthly subscriptions** (`mode: "subscription"`). The
  `customer.subscription.*` webhook events keep each member's status current;
  a cancelled or unpaid subscription revokes dashboard access.
- Members manage or cancel their plan via the Stripe Billing Portal
  (`/api/billing/portal`). Enable it once in the Stripe Dashboard:
  **Settings → Billing → Customer portal**.
- Change `JWT_SECRET` before deploying to production.

## Per-user AWS workspaces

On signup, [src/lib/workspace.ts](src/lib/workspace.ts) runs the Terraform
module under [`terraform/workspace/`](terraform/workspace/README.md) and
provisions, **per subscriber**:

| Resource | Notes |
|---|---|
| EC2 (Amazon Linux 2023) | Size mapped from plan: starter→t3.micro, pro→t3.small, premium→t3.medium |
| S3 bucket | Private, AES-256 SSE, force-destroy on cancel |
| Security group | SSH (22) + workspace server (9099) |
| IAM user + access key | Scoped to that instance, its SG, and the bucket |
| Workspace HTTP server (`:9099`) | Installed by user-data — `POST /backup` snapshots all EBS volumes; `POST /restore` creates a volume from a snapshot and attaches it |

The instance has `INSTANCE_ID`, `BUCKET_ID`, `AWS_REGION`, and the IAM user's
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` injected as env vars.

**Setup:**
1. Install [Terraform](https://www.terraform.io/downloads) 1.5+.
2. Add `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` to `.env.local`. The IAM identity needs EC2 / S3 / IAM / security-group create permissions.
3. New signups will be provisioned in the background. Cancelling a subscription tears the workspace down via the `customer.subscription.deleted` webhook.

**Manually manage a workspace:**
```bash
npm run workspace -- status    user@example.com
npm run workspace -- provision user@example.com --plan pro
npm run workspace -- destroy   user@example.com
```

Per-user state lives at `terraform/workspaces/<userId>/` (git-ignored). The
IAM secret access key is stored on the User document — encrypt at rest for
production deployments.

## Project structure

```
src/
├── app/
│   ├── api/            # checkout, Stripe webhook, auth, contact, workspace, billing
│   ├── login/  signup/  forgot-password/  reset-password/
│   ├── contact/  dashboard/
│   ├── layout.tsx  page.tsx  globals.css
├── components/         # Navbar, Footer, Hero, Features, Pricing, AuthLayout, ui
├── lib/                # config, db, stripe, auth, email, workspace
└── models/             # User, Purchase, Contact (Mongoose)

terraform/
└── workspace/          # per-user AWS workspace module (EC2 + S3 + IAM + SG)
    └── server/         # Node HTTP server installed onto each EC2

scripts/
└── workspace.mjs       # CLI: provision / destroy / status by email or userId
```
