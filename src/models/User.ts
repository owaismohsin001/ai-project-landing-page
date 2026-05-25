import mongoose, { Schema, model, models } from "mongoose";

/** Provisioned AWS workspace for a member (created by Terraform on signup). */
export interface IUserWorkspace {
  instanceId: string;
  publicIp: string;
  publicDns: string;
  bucketName: string;
  iamAccessKeyId: string;
  /** NOTE: stored plaintext for the MVP — encrypt at rest for production. */
  iamSecretAccessKey: string;
  url: string;
}

export interface IUser {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  plan: string;
  /** The Stripe Checkout session that unlocked this account. */
  stripeSessionId?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  /** Live subscription status, kept current by the Stripe webhook. */
  subscriptionStatus: string;
  /** Workspace lifecycle: provisioning | ready | failed | destroying | destroyed. */
  workspaceStatus?: string;
  workspaceError?: string;
  workspace?: IUserWorkspace;
  resetTokenHash?: string;
  resetTokenExpiry?: Date;
  createdAt: Date;
}

const workspaceSchema = new Schema<IUserWorkspace>(
  {
    instanceId: { type: String, required: true },
    publicIp: { type: String, required: true },
    publicDns: { type: String, required: true },
    bucketName: { type: String, required: true },
    iamAccessKeyId: { type: String, required: true },
    iamSecretAccessKey: { type: String, required: true },
    url: { type: String, required: true },
  },
  { _id: false }
);

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    plan: { type: String, required: true },
    stripeSessionId: { type: String },
    stripeCustomerId: { type: String },
    stripeSubscriptionId: { type: String },
    subscriptionStatus: { type: String, default: "active" },
    workspaceStatus: { type: String },
    workspaceError: { type: String },
    workspace: { type: workspaceSchema },
    resetTokenHash: { type: String },
    resetTokenExpiry: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const User =
  (models.User as mongoose.Model<IUser>) || model<IUser>("User", userSchema);
