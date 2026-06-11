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

/**
 * Root EBS volume size in GiB per plan. All plans use 40 GiB because the
 * pre-baked workspace AMI's snapshot is 40 GiB — AWS rejects launches
 * with volume_size < snapshot_size. (Pre-AMI, starter could fit in 20
 * because cloud-init.sh installed everything from scratch onto a thin
 * Ubuntu root; provision.sh inherits the AMI's footprint instead.)
 */
export const PLAN_VOLUME_SIZES: Record<PlanId, number> = {
  starter: 40,
  pro: 40,
  premium: 40,
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
  vars: Record<string, string | number>
): Promise<void> {
  // Strings → JSON-quoted; numbers → unquoted literals. Terraform's
  // tfvars parser respects the distinction and matches the variable
  // type. Quoting a number works via implicit cast, but emitting the
  // proper type avoids any future surprises in stricter Terraform
  // versions or with downstream tooling that reads tfvars directly.
  const content =
    Object.entries(vars)
      .map(([k, v]) =>
        typeof v === "number" ? `${k} = ${v}` : `${k} = ${JSON.stringify(v)}`
      )
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
 * After terraform finishes, the EC2 instance is "created" but cloud-init is
 * still installing apt packages, Node, Docker, the Playwright container, etc.
 * for several more minutes. During that window the public URL returns 502
 * or 504 from Traefik because the upstream (Next.js / code-server) isn't
 * bound yet.
 *
 * If we flip status to "ready" the instant terraform exits, users click
 * "Open workspace" and land on a Bad Gateway page. So we poll the URL
 * until it actually responds with a non-5xx, then return.
 *
 * Anything < 500 counts as "alive" — including 3xx redirects and 404s.
 * Only 5xx (typically 502 / 503 / 504 from Traefik) means the upstream is
 * still down.
 *
 * Progress reporting maps the wait into the 95-99% range so the UI bar
 * keeps creeping forward while we wait, instead of looking frozen at 95%.
 *
 * Caps at MAX_WAIT_MS — if cloud-init genuinely fails we don't want to
 * pin the request open forever. After the cap we log a warning and let
 * the caller proceed; the user will see a brief 502 and can refresh.
 */
async function waitForWorkspaceReady(
  url: string,
  onProgress?: (pct: number) => void | Promise<void>
): Promise<void> {
  // How often we hit the URL. 3s strikes a balance between snappy
  // detection-of-ready and not hammering Traefik / Cloudflare during the
  // long cloud-init window.
  const INTERVAL_MS = 3_000;
  // Hard ceiling on the whole wait. Beyond 10 min something has likely
  // gone wrong (cloud-init failure, IAM throttling, AMI issue) and the
  // user is better off being shown the "ready" state with a stale URL —
  // they can refresh / re-provision rather than stare at a frozen bar.
  const MAX_WAIT_MS = 10 * 60_000;
  // Per-request timeout. 8s is plenty for a healthy upstream and lets us
  // move on quickly if Traefik is just hanging on a 502.
  const REQUEST_TIMEOUT_MS = 8_000;
  // Progress display range while we wait.
  const RANGE_START = 95;
  const RANGE_END = 99;
  // We map the progress *display* over a SHORTER window than the actual
  // max wait. The bar reaches 99 in ~3 minutes regardless of whether the
  // URL is actually up yet, so the user sees clear movement during the
  // longest part of provisioning instead of "stuck at 95%" for 10+ min.
  // After hitting 99 the bar parks there until the URL responds, at
  // which point the caller flips status to "ready" and progress to 100.
  const PROGRESS_RAMP_MS = 3 * 60_000;

  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    attempt += 1;
    let alive = false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        // Don't auto-follow — we only need to know the upstream answered.
        // A 307/302 from Next.js root still proves the server is up.
        redirect: "manual",
        // Don't let any HTTP cache (Cloudflare, browser, etc.) serve us
        // a stale 502 — every poll must hit origin.
        cache: "no-store",
      });
      if (res.status < 500) alive = true;
    } catch {
      // Network error, DNS, abort — treat as "not ready yet" and keep polling.
    } finally {
      clearTimeout(timer);
    }

    if (alive) {
      // URL responded — jump straight to RANGE_END so the bar finishes
      // its run, then return. The caller flips status to "ready" and
      // progress to 100 in a single DB write right after this.
      if (onProgress) await onProgress(RANGE_END);
      console.log(
        `[workspace] waitForWorkspaceReady: ${url} responded on attempt ${attempt} (${Math.round((Date.now() - startedAt) / 1000)}s)`
      );
      return;
    }

    // Ramp progress over PROGRESS_RAMP_MS, capped at RANGE_END. Ceil so
    // sub-integer increments aren't rounded out — without this, each
    // 3s poll bumped pct by ~0.07% and the persistence layer rounded
    // every value back to 95 for the first ~13 minutes.
    if (onProgress) {
      const elapsed = Date.now() - startedAt;
      const frac = Math.min(1, elapsed / PROGRESS_RAMP_MS);
      const raw = RANGE_START + frac * (RANGE_END - RANGE_START);
      await onProgress(Math.min(RANGE_END, Math.ceil(raw)));
    }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  console.warn(
    `[workspace] waitForWorkspaceReady: gave up after ${MAX_WAIT_MS / 1000}s on ${url} — user may see a brief 502 on Open workspace`
  );
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
  const volumeSize = PLAN_VOLUME_SIZES[input.plan];
  if (!volumeSize) {
    throw new Error(`No volume size mapped for plan "${input.plan}".`);
  }

  // Pre-baked workspace AMI. provision.sh hard-fails if the AMI isn't a
  // baked one (no /etc/ai-ide-ami-version), so we refuse to provision
  // when WORKSPACE_AMI_ID isn't set rather than silently fall back to a
  // stock Ubuntu image that would brick the EC2 mid-boot.
  const workspaceAmiId = process.env.WORKSPACE_AMI_ID;
  if (!workspaceAmiId || !/^ami-[0-9a-f]{8,17}$/.test(workspaceAmiId)) {
    throw new Error(
      "WORKSPACE_AMI_ID is not set (or not an ami-xxxxxxxx id). Bake a workspace AMI with terraform/workspace/bake.sh and put its id in the platform env."
    );
  }

  // Wrap the optional callback so the rest of this function can call it
  // unconditionally + swallow any error from a slow DB write (we never
  // want a progress-tracking failure to abort actual provisioning).
  //
  // Capped at 99 — the final flip to 100 happens in provisionUserWorkspace
  // when it writes status="ready" to the DB. That separation guarantees
  // the bar never reads "100% complete" before the workspace document is
  // actually persisted with the EC2 / S3 / IAM details the dashboard reads.
  //
  // Math.ceil instead of Math.round: small ramp increments (e.g. 95.05,
  // 95.10, 95.15 ... over the wait phase) were getting rounded back to 95
  // and never advanced the UI. Ceil moves us up as soon as we cross any
  // integer boundary — once we hit 95.01, the bar shows 96. The 99 cap
  // keeps that from overshooting.
  const reportProgress = async (pct: number) => {
    if (!onProgress) return;
    try {
      await onProgress(Math.min(99, Math.max(0, Math.ceil(pct))));
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
    volume_size: volumeSize,
    workspace_ami_id: workspaceAmiId,
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
    // Landing-page API base the workspace calls during provisioning to fetch
    // a Headscale mesh auth key (/api/workspace/mesh-authkey). The EC2 must be
    // able to reach this over the public internet, so it's the public platform
    // URL, not localhost.
    platform_api_url: (
      process.env.PLATFORM_API_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      ""
    ).replace(/\/+$/, ""),
    workspace_provision_secret: process.env.WORKSPACE_PROVISION_SECRET || "",
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

  // Terraform has exited but the EC2 is still mid-cloud-init: apt installs,
  // node_modules, docker pull, etc. — typically another 5–10 minutes. Poll
  // the public URL until it actually responds so users don't click "Open
  // workspace" and land on a 502 Bad Gateway from Traefik.
  await waitForWorkspaceReady(outputs.workspace_url.value, async (pct) => {
    // Forward via the outer onProgress wrapper so the 95-cap + min/max
    // clamping in reportProgress() still applies.
    await reportProgress(pct);
  });

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

  // Coalesce progress updates so we don't hammer Mongo. The previous
  // throttle ("skip if delta < 5%") meant the 95→99 wait-phase ramp —
  // which advances by ~1% at a time — was always below the threshold and
  // never wrote anything, so the bar visibly froze at 95% for the whole
  // wait. New rule:
  //   - Always write when the integer value changes (so every 1% bump
  //     shows up in the next dashboard poll).
  //   - Otherwise, heartbeat every 5s so a slow ramp still writes once
  //     in a while (useful when the cap-99 plateau is reached and we're
  //     just holding pattern).
  let lastWritten = -1;
  let lastWriteAt = 0;
  const persistProgress = async (pct: number) => {
    const now = Date.now();
    const isFirst = lastWritten < 0;
    const changed = pct !== lastWritten;
    const heartbeat = now - lastWriteAt >= 5_000;
    if (!isFirst && !changed && !heartbeat) return;
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
