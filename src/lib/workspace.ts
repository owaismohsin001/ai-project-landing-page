import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { User } from "@/models/User";
import type { PlanId } from "./config";
import { connectToDatabase } from "./db";

/**
 * Per-user workspace provisioning.
 *
 * Each subscriber gets a private AWS workspace (EC2 + S3 + IAM) defined by the
 * Terraform module under `terraform/workspace/`. State is kept per-user under
 * `terraform/workspaces/<userId>/` so concurrent users don't clobber each other.
 */

const PROJECT_ROOT = process.cwd();
const MODULE_DIR = path.join(PROJECT_ROOT, "terraform", "workspace");
const WORKSPACES_DIR = path.join(PROJECT_ROOT, "terraform", "workspaces");
const TERRAFORM_BIN = process.env.TERRAFORM_BIN || "terraform";

/** EC2 instance type per plan. See terraform/workspace/README.md for cost math. */
export const PLAN_INSTANCE_TYPES: Record<PlanId, string> = {
  starter: "t3.micro",
  pro: "t3.small",
  premium: "t3.medium",
};

export interface ProvisionInput {
  userId: string;
  plan: PlanId;
}

export interface WorkspaceOutputs {
  instanceId: string;
  publicIp: string;
  publicDns: string;
  bucketName: string;
  securityGroupId: string;
  iamUserName: string;
  iamAccessKeyId: string;
  iamSecretAccessKey: string;
  workspaceUrl: string;
}

export function isAwsConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  );
}

function awsEnv(): NodeJS.ProcessEnv {
  const region = process.env.AWS_REGION || "us-west-2";
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    CHECKPOINT_DISABLE: "1", // no telemetry pings from terraform
  };
}

async function workspaceDir(userId: string): Promise<string> {
  const dir = path.join(WORKSPACES_DIR, userId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Copy module source files into the user's working directory. */
async function copyModuleInto(dir: string): Promise<void> {
  const entries = await fs.readdir(MODULE_DIR, { withFileTypes: true });
  for (const entry of entries) {
    // Skip anything stateful that might be in the source dir.
    if (
      entry.name === ".terraform" ||
      entry.name === "terraform.tfvars" ||
      entry.name.endsWith(".tfstate") ||
      entry.name.endsWith(".tfstate.backup")
    ) {
      continue;
    }
    const src = path.join(MODULE_DIR, entry.name);
    const dst = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await fs.cp(src, dst, { recursive: true, force: true });
    } else {
      await fs.copyFile(src, dst);
    }
  }
}

async function writeTfvars(
  dir: string,
  vars: Record<string, string>
): Promise<void> {
  const content =
    Object.entries(vars)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join("\n") + "\n";
  await fs.writeFile(path.join(dir, "terraform.tfvars"), content);
}

interface TerraformResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a terraform command. If `onLine` is supplied, each newline-terminated
 * stdout chunk is forwarded to it as it arrives — used for streaming progress
 * updates during `terraform apply`. Without `onLine`, output is just buffered
 * up and returned at the end as before.
 */
function runTerraform(
  cwd: string,
  args: string[],
  onLine?: (line: string) => void
): Promise<TerraformResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TERRAFORM_BIN, args, {
      cwd,
      env: awsEnv(),
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    // Partial line buffer — terraform writes in chunks that don't line up
    // with line boundaries, so we hold the trailing fragment until the next
    // chunk completes it.
    let lineBuf = "";
    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!onLine) return;
      lineBuf += chunk;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      // Flush any pending partial line.
      if (onLine && lineBuf) onLine(lineBuf);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function expectTerraform(
  cwd: string,
  args: string[],
  label: string,
  onLine?: (line: string) => void
): Promise<TerraformResult> {
  const result = await runTerraform(cwd, args, onLine);
  if (result.code !== 0) {
    throw new Error(
      `${label} failed (code ${result.code}):\n${result.stderr || result.stdout}`
    );
  }
  return result;
}

/**
 * Apex domain Traefik routes per-user services under. Service URLs are
 * built as `<service>.<userId>.<PLATFORM_DOMAIN>` and resolve through the
 * Cloudflare wildcard → ALB → central Traefik → per-user Traefik path.
 */
const PLATFORM_DOMAIN =
  process.env.PLATFORM_DOMAIN || "platform.bytescripterz.com";

/**
 * Scheme used in service URLs the browser will hit (frontend-X.platform...,
 * api-X.platform..., etc.). Set to "https" once the proxy module has been
 * applied with enable_https=true and the ACM cert is validated. Defaults
 * to http so existing HTTP-only deployments keep working.
 */
const PLATFORM_PROTOCOL = (
  process.env.PLATFORM_PROTOCOL || "http"
).toLowerCase() === "https"
  ? "https"
  : "http";

/**
 * Base URL of the traefik-router service that lives on the proxy EC2 (see
 * terraform/proxy/router/). Each user workspace's per-EC2 Traefik polls
 * `${base}/<userId>` for its dynamic config. Comes from the proxy
 * module's `router_base_url` output.
 */
const TRAEFIK_ROUTER_BASE_URL =
  process.env.TRAEFIK_ROUTER_BASE_URL ||
  "http://localhost:9100/api/traefik/user";

export async function provisionWorkspace(
  input: ProvisionInput,
  /** Optional callback invoked with a 0-100 percentage as terraform makes
   *  observable progress. Stay under 95 — the caller flips to 100 only
   *  once status transitions to "ready" so the bar can never claim "done"
   *  before the DB write that records the workspace details. */
  onProgress?: (pct: number) => void | Promise<void>
): Promise<WorkspaceOutputs> {
  if (!isAwsConfigured()) {
    throw new Error(
      "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set in the environment."
    );
  }
  const instanceType = PLAN_INSTANCE_TYPES[input.plan];
  if (!instanceType) {
    throw new Error(`No instance type mapped for plan "${input.plan}".`);
  }

  // Wrap the optional callback so the rest of this function can call it
  // unconditionally + swallow any error from a slow DB write (we never
  // want a progress-tracking failure to abort actual provisioning).
  const reportProgress = async (pct: number) => {
    if (!onProgress) return;
    try {
      await onProgress(Math.min(95, Math.max(0, Math.round(pct))));
    } catch {
      /* ignore */
    }
  };

  await reportProgress(2);

  const dir = await workspaceDir(input.userId);
  await copyModuleInto(dir);
  await writeTfvars(dir, {
    region: process.env.AWS_REGION || "us-west-2",
    user_id: input.userId,
    instance_type: instanceType,
    platform_domain: PLATFORM_DOMAIN,
    platform_protocol: PLATFORM_PROTOCOL,
    backend_config_url: `${TRAEFIK_ROUTER_BASE_URL.replace(/\/+$/, "")}/${input.userId}`,
    // Base URL of the proxy router itself (no path) — backend uses it to
    // register services. Strip "/api/traefik/user" off the configured
    // base. e.g. http://proxy:9100/api/traefik/user → http://proxy:9100
    proxy_router_url: TRAEFIK_ROUTER_BASE_URL.replace(
      /\/api\/traefik\/user\/?$/,
      ""
    ),
  });

  await reportProgress(5);

  await expectTerraform(
    dir,
    ["init", "-input=false", "-no-color"],
    "terraform init"
  );

  await reportProgress(15);

  // Stream terraform-apply stdout and translate it into a 15→90 % ramp.
  // The plan line ("Plan: N to add, …") tells us how many resources are
  // about to be created; we map each "Creation complete" line to a
  // proportional bump. If for some reason we never see the plan line, we
  // fall back to bumping a fixed amount per completed resource.
  let totalResources = 0;
  let resourcesCreated = 0;
  // 75% range of progress is shared across all resources during apply.
  const APPLY_RANGE_START = 15;
  const APPLY_RANGE_END = 90;
  const APPLY_RANGE = APPLY_RANGE_END - APPLY_RANGE_START;

  const onApplyLine = (line: string) => {
    // "Plan: 10 to add, 0 to change, 0 to destroy."
    const planMatch = line.match(/^Plan:\s+(\d+)\s+to add\b/);
    if (planMatch) {
      totalResources = parseInt(planMatch[1], 10);
      void reportProgress(APPLY_RANGE_START + 2);
      return;
    }
    // "aws_iam_user.workspace: Creation complete after 1s [id=…]"
    if (/:\s+Creation complete after\b/.test(line)) {
      resourcesCreated += 1;
      const denom = totalResources > 0 ? totalResources : resourcesCreated + 3;
      const pct = APPLY_RANGE_START + (resourcesCreated / denom) * APPLY_RANGE;
      void reportProgress(pct);
      return;
    }
    // "Apply complete! Resources: 10 added, 0 changed, 0 destroyed."
    if (/^Apply complete!/.test(line)) {
      void reportProgress(90);
    }
  };

  await expectTerraform(
    dir,
    ["apply", "-input=false", "-auto-approve", "-no-color"],
    "terraform apply",
    onApplyLine
  );

  await reportProgress(92);

  const out = await expectTerraform(
    dir,
    ["output", "-json", "-no-color"],
    "terraform output"
  );
  const outputs = JSON.parse(out.stdout) as Record<string, { value: string }>;

  await reportProgress(95);

  return {
    instanceId: outputs.instance_id.value,
    publicIp: outputs.instance_public_ip.value,
    publicDns: outputs.instance_public_dns.value,
    bucketName: outputs.bucket_name.value,
    securityGroupId: outputs.security_group_id.value,
    iamUserName: outputs.iam_user_name.value,
    iamAccessKeyId: outputs.iam_access_key_id.value,
    iamSecretAccessKey: outputs.iam_secret_access_key.value,
    workspaceUrl: outputs.workspace_url.value,
  };
}

export async function destroyWorkspace(userId: string): Promise<void> {
  if (!isAwsConfigured()) {
    throw new Error(
      "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set in the environment."
    );
  }
  const dir = await workspaceDir(userId);
  const stateExists = await fs
    .access(path.join(dir, "terraform.tfstate"))
    .then(() => true)
    .catch(() => false);
  if (!stateExists) return; // nothing to destroy

  await expectTerraform(
    dir,
    ["destroy", "-input=false", "-auto-approve", "-no-color"],
    "terraform destroy"
  );
}

/* ── Background helpers that also persist status to the User document ── */

/**
 * Provision in the background and write the result onto the user. Safe to
 * fire-and-forget — any error is logged and stored in `workspaceError`.
 */
export async function provisionUserWorkspace(
  userIdStr: string,
  plan: PlanId
): Promise<void> {
  await connectToDatabase();
  await User.updateOne(
    { _id: userIdStr },
    {
      $set: { workspaceStatus: "provisioning", workspaceProgress: 0 },
      $unset: { workspaceError: "" },
    }
  );

  // Coalesce rapid-fire progress updates so we don't hammer Mongo. The bar
  // updates visually every poll (the dashboard polls every 5s), so writing
  // more often than ~1s adds load without improving UX.
  let lastWritten = -1;
  let lastWriteAt = 0;
  const persistProgress = async (pct: number) => {
    const now = Date.now();
    // Always persist the first update + any >= 5% delta, throttle the rest
    // to at most once per ~750ms.
    const isFirst = lastWritten < 0;
    const bigDelta = Math.abs(pct - lastWritten) >= 5;
    const elapsed = now - lastWriteAt;
    if (!isFirst && !bigDelta && elapsed < 750) return;
    lastWritten = pct;
    lastWriteAt = now;
    await User.updateOne(
      { _id: userIdStr },
      { $set: { workspaceProgress: pct } }
    );
  };

  try {
    const out = await provisionWorkspace(
      { userId: userIdStr, plan },
      persistProgress
    );
    await User.updateOne(
      { _id: userIdStr },
      {
        $set: {
          workspaceStatus: "ready",
          workspaceProgress: 100,
          workspace: {
            instanceId: out.instanceId,
            publicIp: out.publicIp,
            publicDns: out.publicDns,
            bucketName: out.bucketName,
            iamAccessKeyId: out.iamAccessKeyId,
            iamSecretAccessKey: out.iamSecretAccessKey,
            url: out.workspaceUrl,
          },
        },
        $unset: { workspaceError: "" },
      }
    );
    console.log(`[workspace] ready for ${userIdStr} → ${out.workspaceUrl}`);
  } catch (err) {
    console.error(`[workspace] provision failed for ${userIdStr}`, err);
    await User.updateOne(
      { _id: userIdStr },
      {
        $set: {
          workspaceStatus: "failed",
          workspaceProgress: 0,
          workspaceError: err instanceof Error ? err.message : String(err),
        },
      }
    );
  }
}

/** Destroy in the background. Safe to fire-and-forget. */
export async function destroyUserWorkspace(userIdStr: string): Promise<void> {
  await connectToDatabase();
  await User.updateOne(
    { _id: userIdStr },
    { $set: { workspaceStatus: "destroying" } }
  );
  try {
    await destroyWorkspace(userIdStr);
    await User.updateOne(
      { _id: userIdStr },
      {
        $set: { workspaceStatus: "destroyed" },
        $unset: { workspace: "", workspaceError: "" },
      }
    );
    console.log(`[workspace] destroyed for ${userIdStr}`);
  } catch (err) {
    console.error(`[workspace] destroy failed for ${userIdStr}`, err);
    await User.updateOne(
      { _id: userIdStr },
      {
        $set: {
          workspaceStatus: "failed",
          workspaceError: err instanceof Error ? err.message : String(err),
        },
      }
    );
  }
}
