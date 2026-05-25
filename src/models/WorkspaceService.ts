import mongoose, { Schema, model, models } from "mongoose";

/**
 * A user-defined HTTP service inside a workspace. The traefik-router on
 * the proxy EC2 (terraform/proxy/router/server.js) reads these and emits
 * one Traefik router/service per doc, so the per-user Traefik picks up
 * `<name>.<userId>.<PLATFORM_DOMAIN>` → `127.0.0.1:<port>` automatically.
 *
 * The three default services (frontend / api / ide) are NOT stored here —
 * they're hard-coded in the router. Users only create rows for extras.
 */
export interface IWorkspaceService {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  /** Subdomain segment — lowercase letters, digits, dashes. */
  name: string;
  /** TCP port the service listens on inside the user's EC2 (1-65535). */
  port: number;
  createdAt: Date;
}

const RESERVED_NAMES = new Set(["frontend", "api", "ide"]);

const workspaceServiceSchema = new Schema<IWorkspaceService>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (v: string) =>
          /^[a-z0-9-]{1,32}$/.test(v) && !RESERVED_NAMES.has(v),
        message:
          "name must be 1-32 chars of [a-z0-9-] and not one of the reserved subdomains (frontend, api, ide).",
      },
    },
    port: {
      type: Number,
      required: true,
      min: 1,
      max: 65535,
      validate: {
        // Block ports already owned by Traefik / the workspace HTTP server.
        validator: (v: number) => v !== 80 && v !== 8081 && v !== 9099,
        message: "port 80, 8081, and 9099 are reserved.",
      },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One service name per user — the router can't route the same Host to two
// different ports.
workspaceServiceSchema.index({ userId: 1, name: 1 }, { unique: true });

export const WorkspaceService =
  (models.WorkspaceService as mongoose.Model<IWorkspaceService>) ||
  model<IWorkspaceService>("WorkspaceService", workspaceServiceSchema);
