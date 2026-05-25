#!/usr/bin/env node
/**
 * Workspace CLI — manually provision / destroy / inspect a user's workspace.
 *
 * Usage:
 *   npm run workspace -- provision <userId|email> [--plan starter|pro|premium]
 *   npm run workspace -- destroy   <userId|email>
 *   npm run workspace -- status    <userId|email>
 *
 * The script reads .env.local via `node --env-file=.env.local` (configured
 * in package.json). It talks to the same Mongo collection as the Next.js app
 * and runs the same Terraform module.
 */
import path from "node:path";
import url from "node:url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Make project-root imports work for the same `@/lib/...` paths Next.js uses.
const projectRoot = path.resolve(__dirname, "..");
process.chdir(projectRoot);

async function main() {
  const [, , cmd, target, ...rest] = process.argv;
  if (!cmd || !target) usage();

  // Lazy imports so the script doesn't crash on missing env until it has to.
  const { connectToDatabase } = await import(
    path.join(projectRoot, "src/lib/db.ts").replace(/\\/g, "/")
  ).catch(() => import("../src/lib/db.js")).catch(() => null) || {};

  // Easier: just use the compiled JS via a small ESM bridge — we run the
  // workspace lib through Next's tsx-aware loader at runtime. To keep this
  // CLI self-contained we re-implement the small surface we need here.
  const { default: mongoose } = await import("mongoose");
  const { provisionWorkspace, destroyWorkspace, PLAN_INSTANCE_TYPES } =
    await loadWorkspaceLib();
  const { User } = await loadUserModel();

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  try {
    const user = await resolveUser(User, target);
    if (!user && cmd !== "destroy") {
      console.error(`No user matched "${target}"`);
      process.exit(1);
    }

    if (cmd === "provision") {
      const plan =
        rest.find((a) => a.startsWith("--plan="))?.split("=")[1] ||
        (rest.includes("--plan") ? rest[rest.indexOf("--plan") + 1] : null) ||
        user.plan;
      if (!plan || !PLAN_INSTANCE_TYPES[plan]) {
        console.error(`Plan must be one of: ${Object.keys(PLAN_INSTANCE_TYPES).join(", ")}`);
        process.exit(1);
      }
      console.log(
        `Provisioning ${plan} workspace for ${user.email} (${user._id})…`
      );
      const out = await provisionWorkspace({
        userId: String(user._id),
        plan,
      });
      await User.updateOne(
        { _id: user._id },
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
      console.log("✅ ready:", out.workspaceUrl);
    } else if (cmd === "destroy") {
      const userId = user ? String(user._id) : target;
      console.log(`Destroying workspace for ${userId}…`);
      await destroyWorkspace(userId);
      if (user) {
        await User.updateOne(
          { _id: user._id },
          {
            $set: { workspaceStatus: "destroyed" },
            $unset: { workspace: "", workspaceError: "" },
          }
        );
      }
      console.log("✅ destroyed");
    } else if (cmd === "status") {
      console.log(`User:           ${user.email}  (${user._id})`);
      console.log(`Plan:           ${user.plan}`);
      console.log(`Subscription:   ${user.subscriptionStatus}`);
      console.log(`Workspace:      ${user.workspaceStatus ?? "none"}`);
      if (user.workspaceError) console.log(`Error:          ${user.workspaceError}`);
      if (user.workspace) {
        console.log(`Instance:       ${user.workspace.instanceId}`);
        console.log(`Public DNS:     ${user.workspace.publicDns}`);
        console.log(`Public IP:      ${user.workspace.publicIp}`);
        console.log(`S3 bucket:      ${user.workspace.bucketName}`);
        console.log(`IAM key id:     ${user.workspace.iamAccessKeyId}`);
        console.log(`URL:            ${user.workspace.url}`);
      }
    } else {
      usage();
    }
  } finally {
    await mongoose.disconnect();
  }
}

function usage() {
  console.error(
    "Usage:\n" +
      "  npm run workspace -- provision <userId|email> [--plan starter|pro|premium]\n" +
      "  npm run workspace -- destroy   <userId|email>\n" +
      "  npm run workspace -- status    <userId|email>"
  );
  process.exit(1);
}

async function resolveUser(User, target) {
  if (target.includes("@")) {
    return User.findOne({ email: target.toLowerCase() });
  }
  return User.findById(target).catch(() => null);
}

/* ── Load the workspace + user modules from the TypeScript sources by
   transpiling them on the fly via Next.js's bundled SWC.  Since this CLI is
   run with `node --env-file=.env.local`, we don't have Next.js's loader.
   So we just re-implement the small surface here. ── */

async function loadWorkspaceLib() {
  // Inline import that matches the lib's public API. This keeps the CLI
  // self-contained — no transpile step required.
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const MODULE_DIR = path.join(projectRoot, "terraform", "workspace");
  const WORKSPACES_DIR = path.join(projectRoot, "terraform", "workspaces");
  const TERRAFORM_BIN = process.env.TERRAFORM_BIN || "terraform";

  const PLAN_INSTANCE_TYPES = {
    starter: "t3.micro",
    pro: "t3.small",
    premium: "t3.medium",
  };

  function awsEnv() {
    const region = process.env.AWS_REGION || "us-west-2";
    return {
      ...process.env,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      CHECKPOINT_DISABLE: "1",
    };
  }

  async function workspaceDir(userId) {
    const dir = path.join(WORKSPACES_DIR, userId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async function copyModuleInto(dir) {
    const entries = await fs.readdir(MODULE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === ".terraform" ||
        entry.name === "terraform.tfvars" ||
        entry.name.endsWith(".tfstate") ||
        entry.name.endsWith(".tfstate.backup")
      )
        continue;
      const src = path.join(MODULE_DIR, entry.name);
      const dst = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await fs.cp(src, dst, { recursive: true, force: true });
      } else {
        await fs.copyFile(src, dst);
      }
    }
  }

  async function writeTfvars(dir, vars) {
    const content =
      Object.entries(vars)
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join("\n") + "\n";
    await fs.writeFile(path.join(dir, "terraform.tfvars"), content);
  }

  function runTerraform(cwd, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(TERRAFORM_BIN, args, {
        cwd,
        env: awsEnv(),
        stdio: ["ignore", "inherit", "inherit"],
      });
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code ?? 1));
    });
  }

  async function expect(cwd, args, label) {
    const code = await runTerraform(cwd, args);
    if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
  }

  async function provisionWorkspace({ userId, plan }) {
    const dir = await workspaceDir(userId);
    await copyModuleInto(dir);
    await writeTfvars(dir, {
      region: process.env.AWS_REGION || "us-west-2",
      user_id: userId,
      instance_type: PLAN_INSTANCE_TYPES[plan],
    });
    await expect(dir, ["init", "-input=false", "-no-color"], "terraform init");
    await expect(
      dir,
      ["apply", "-input=false", "-auto-approve", "-no-color"],
      "terraform apply"
    );
    // Capture outputs.
    const out = await new Promise((resolve, reject) => {
      const chunks = [];
      const proc = spawn(
        TERRAFORM_BIN,
        ["output", "-json", "-no-color"],
        { cwd: dir, env: awsEnv() }
      );
      proc.stdout.on("data", (d) => chunks.push(d));
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0
          ? resolve(Buffer.concat(chunks).toString())
          : reject(new Error(`terraform output failed (${code})`))
      );
    });
    const parsed = JSON.parse(out);
    return {
      instanceId: parsed.instance_id.value,
      publicIp: parsed.instance_public_ip.value,
      publicDns: parsed.instance_public_dns.value,
      bucketName: parsed.bucket_name.value,
      securityGroupId: parsed.security_group_id.value,
      iamUserName: parsed.iam_user_name.value,
      iamAccessKeyId: parsed.iam_access_key_id.value,
      iamSecretAccessKey: parsed.iam_secret_access_key.value,
      workspaceUrl: parsed.workspace_url.value,
    };
  }

  async function destroyWorkspace(userId) {
    const dir = await workspaceDir(userId);
    const stateExists = await fs
      .access(path.join(dir, "terraform.tfstate"))
      .then(() => true)
      .catch(() => false);
    if (!stateExists) return;
    await expect(
      dir,
      ["destroy", "-input=false", "-auto-approve", "-no-color"],
      "terraform destroy"
    );
  }

  return { provisionWorkspace, destroyWorkspace, PLAN_INSTANCE_TYPES };
}

async function loadUserModel() {
  const mongoose = (await import("mongoose")).default;
  const { Schema, model, models } = mongoose;
  const workspaceSchema = new Schema(
    {
      instanceId: String,
      publicIp: String,
      publicDns: String,
      bucketName: String,
      iamAccessKeyId: String,
      iamSecretAccessKey: String,
      url: String,
    },
    { _id: false }
  );
  const userSchema = new Schema(
    {
      name: String,
      email: { type: String, lowercase: true, trim: true },
      passwordHash: String,
      plan: String,
      stripeSessionId: String,
      stripeCustomerId: String,
      stripeSubscriptionId: String,
      subscriptionStatus: String,
      workspaceStatus: String,
      workspaceError: String,
      workspace: workspaceSchema,
    },
    { timestamps: { createdAt: true, updatedAt: false } }
  );
  return { User: models.User || model("User", userSchema) };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
