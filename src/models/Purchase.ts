import mongoose, { Schema, model, models } from "mongoose";

/**
 * A completed Stripe Checkout. A completed, unused purchase must exist before
 * a matching account can be created — this is what gates signup.
 */
export interface IPurchase {
  _id: mongoose.Types.ObjectId;
  stripeSessionId: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  email: string;
  plan: string;
  /** First-invoice amount, in whole USD. */
  amount: number;
  currency: string;
  /** Checkout session status (e.g. "complete"). */
  status: string;
  /** Subscription status captured at checkout time (e.g. "active"). */
  subscriptionStatus: string;
  /** True once an account has been created from this purchase. */
  used: boolean;
  createdAt: Date;
}

const purchaseSchema = new Schema<IPurchase>(
  {
    stripeSessionId: { type: String, required: true, unique: true },
    stripeSubscriptionId: { type: String },
    stripeCustomerId: { type: String },
    email: { type: String, required: true, lowercase: true, trim: true },
    plan: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "usd" },
    status: { type: String, default: "complete" },
    subscriptionStatus: { type: String, default: "active" },
    used: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const Purchase =
  (models.Purchase as mongoose.Model<IPurchase>) ||
  model<IPurchase>("Purchase", purchaseSchema);
