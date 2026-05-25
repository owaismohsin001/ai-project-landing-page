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

function runTerraform(
  cwd: string,
  args: string[]
): Promise<TerraformResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TERRAFORM_BIN, args, {
      cwd,
      env: awsEnv(),
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function expectTerraform(
  cwd: string,
  args: string[],
  label: string
): Promise<TerraformResult> {
  const result = await runTerraform(cwd, args);
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
  input: ProvisionInput
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

  await expectTerraform(
    dir,
    ["init", "-input=false", "-no-color"],
    "terraform init"
  );
  await expectTerraform(
    dir,
    ["apply", "-input=false", "-auto-approve", "-no-color"],
    "terraform apply"
  );

  const out = await expectTerraform(
    dir,
    ["output", "-json", "-no-color"],
    "terraform output"
  );
  const outputs = JSON.parse(out.stdout) as Record<string, { value: string }>;

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
      $set: { workspaceStatus: "provisioning" },
      $unset: { workspaceError: "" },
    }
  );

  try {
    const out = await provisionWorkspace({ userId: userIdStr, plan });
    await User.updateOne(
      { _id: userIdStr },
      {
        $set: {
          workspaceStatus: "ready",
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
