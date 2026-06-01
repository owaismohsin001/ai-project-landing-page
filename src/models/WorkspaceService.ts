import mongoose, { Schema, model, models } from "mongoose";

/**
 * A user-defined HTTP service inside a workspace. The traefik-router on
 * the proxy EC2 (terraform/proxy/router/server.js) reads these and emits
 * one Traefik router/service per doc, so the per-user Traefik picks up
 * `<name>.<userId>.<PLATFORM_DOMAIN>` → `127.0.0.1:<port>` automatically.
 *
 * The default services (frontend / api / ide / docs / sheets / docs-agent
 * / sheets-agent) are NOT stored here — they're hard-coded in the router.
 * Users only create rows for extras.
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

const RESERVED_NAMES = new Set([
  "frontend",
  "api",
  "ide",
  // Pre-installed office editors (ONLYOFFICE Docs Server) + their
  // Playwright-driven agent sidecars. Defined as DEFAULT_SERVICES in the
  // proxy router; users cannot shadow them.
  "docs",
  "sheets",
  "docs-agent",
  "sheets-agent",
]);

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
          "name must be 1-32 chars of [a-z0-9-] and not one of the reserved subdomains (frontend, api, ide, docs, sheets, docs-agent, sheets-agent).",
      },
    },
    port: {
      type: Number,
      required: true,
      min: 1,
      max: 65535,
      validate: {
        // Block ports already owned by Traefik / the workspace HTTP
        // server / pre-installed office services. Keep in sync with
        // RESERVED_PORTS in terraform/proxy/router/server.js.
        validator: (v: number) =>
          v !== 80 &&
          v !== 8081 &&
          v !== 9099 &&
          v !== 4000 &&
          v !== 4001 &&
          v !== 4100 &&
          v !== 4101,
        message:
          "port 80, 8081, 9099, 4000, 4001, 4100, and 4101 are reserved.",
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
