#!/usr/bin/env node
/**
 * One-shot AMI smoke test.
 *
 *   node --env-file=.env.local scripts/test-ami.mjs <subcommand>
 *
 * Subcommands:
 *   start      Insert fake user + terraform apply against the live AMI.
 *              Writes the resulting user id + workspace url to .ami-test.json.
 *   logs       SSH in (EC2 Instance Connect) + tail the relevant journals.
 *   destroy    terraform destroy + remove the fake user from Mongo.
 *
 * Mirrors src/lib/workspace.ts so we exercise the same provisioning path
 * a real subscriber would, minus Stripe. Stays inline (no tsx) so this is
 * self-contained.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { MongoClient, ObjectId } from "mongodb";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
process.chdir(projectRoot);

const STATE_FILE = path.join(projectRoot, ".ami-test.json");
const TERRAFORM_BIN = process.env.TERRAFORM_BIN || "terraform";

function awsEnv() {
  const region = process.env.AWS_REGION || "us-west-2";
  // C: drive is full on this dev box; force terraform's provider downloads
  // + temp scratch to D:\tf-temp where there's space.
  const tmpDir = process.env.AMI_TEST_TMP || "D:\\tf-temp";
  fssync.mkdirSync(tmpDir, { recursive: true });
  return {
    ...process.env,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    CHECKPOINT_DISABLE: "1",
    TMP: tmpDir,
    TEMP: tmpDir,
    TMPDIR: tmpDir,
  };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: "inherit",
      env: opts.env || awsEnv(),
      cwd: opts.cwd,
      shell: false,
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exit ${code}`))
    );
  });
}

function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    env: opts.env || awsEnv(),
    cwd: opts.cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`
    );
  }
  return r.stdout;
}

async function copyModuleInto(dir) {
  const MODULE_DIR = path.join(projectRoot, "terraform", "workspace");
  const entries = await fs.readdir(MODULE_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === "terraform.tfvars" ||
      entry.name.endsWith(".tfstate") ||
      entry.name.endsWith(".tfstate.backup")
    )
      continue;
    // Keep .terraform/ (cached providers) so terraform init can reuse it.
    // Network to releases.hashicorp.com keeps flaking from PK — re-downloading
    // the 600+ MB provider on every test bricks the run.
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
  const lines = Object.entries(vars)
    .map(([k, v]) => (typeof v === "number" ? `${k} = ${v}` : `${k} = ${JSON.stringify(v)}`))
    .join("\n");
  await fs.writeFile(path.join(dir, "terraform.tfvars"), lines + "\n");
}

async function withMongo(fn) {
  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  try {
    return await fn(c.db());
  } finally {
    await c.close();
  }
}

function genTestUserId() {
  // 24-char hex, matches Mongo ObjectId format. The proxy router rejects
  // anything else for /api/traefik/user/<id>.
  return new ObjectId().toHexString();
}

async function cmdStart() {
  if (!process.env.WORKSPACE_AMI_ID) throw new Error("WORKSPACE_AMI_ID is not set");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");

  const userId = genTestUserId();
  const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN || "platform.bytescripterz.com";
  const PLATFORM_PROTOCOL = (process.env.PLATFORM_PROTOCOL || "http").toLowerCase();
  const TRAEFIK_ROUTER_BASE_URL =
    process.env.TRAEFIK_ROUTER_BASE_URL ||
    "http://localhost:9100/api/traefik/user";

  console.log(`[test-ami] fake user id: ${userId}`);
  console.log(`[test-ami] AMI: ${process.env.WORKSPACE_AMI_ID}`);

  await withMongo(async (db) => {
    await db.collection("users").insertOne({
      _id: new ObjectId(userId),
      email: `ami-smoke-${userId}@bake-test.invalid`,
      workspaceStatus: "provisioning",
      createdAt: new Date(),
    });
  });

  const dir = path.join(projectRoot, "terraform", "workspaces", userId);
  await fs.mkdir(dir, { recursive: true });
  await copyModuleInto(dir);
  await writeTfvars(dir, {
    region: process.env.AWS_REGION || "us-west-2",
    user_id: userId,
    instance_type: "t3.large",
    volume_size: 40,
    workspace_ami_id: process.env.WORKSPACE_AMI_ID,
    platform_domain: PLATFORM_DOMAIN,
    platform_protocol: PLATFORM_PROTOCOL,
    backend_config_url: `${TRAEFIK_ROUTER_BASE_URL.replace(/\/+$/, "")}/${userId}`,
    proxy_router_url: TRAEFIK_ROUTER_BASE_URL.replace(/\/api\/traefik\/user\/?$/, ""),
  });

  console.log("[test-ami] terraform init");
  await run(TERRAFORM_BIN, ["init", "-input=false", "-no-color"], { cwd: dir });
  console.log("[test-ami] terraform apply");
  await run(TERRAFORM_BIN, ["apply", "-input=false", "-auto-approve", "-no-color"], {
    cwd: dir,
  });

  const out = JSON.parse(
    capture(TERRAFORM_BIN, ["output", "-json", "-no-color"], { cwd: dir })
  );
  const result = {
    userId,
    dir,
    instanceId: out.instance_id.value,
    publicIp: out.instance_public_ip.value,
    publicDns: out.instance_public_dns.value,
    bucketName: out.bucket_name.value,
    iamUserName: out.iam_user_name.value,
    workspaceUrl: out.workspace_url.value,
  };

  await withMongo(async (db) => {
    await db.collection("users").updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          workspaceStatus: "ready",
          workspace: {
            instanceId: result.instanceId,
            publicIp: result.publicIp,
            publicDns: result.publicDns,
            bucketName: result.bucketName,
            iamAccessKeyId: out.iam_access_key_id.value,
            iamSecretAccessKey: out.iam_secret_access_key.value,
            url: result.workspaceUrl,
          },
        },
      }
    );
  });

  fssync.writeFileSync(STATE_FILE, JSON.stringify(result, null, 2));
  console.log(`[test-ami] state written → ${STATE_FILE}`);
  console.log("[test-ami] outputs:");
  console.log(JSON.stringify(result, null, 2));
}

async function cmdDestroy() {
  const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  console.log(`[test-ami] destroying ${state.userId} (${state.instanceId})`);
  await run(TERRAFORM_BIN, ["destroy", "-input=false", "-auto-approve", "-no-color"], {
    cwd: state.dir,
  });
  await withMongo(async (db) => {
    await db.collection("users").deleteOne({ _id: new ObjectId(state.userId) });
    console.log("[test-ami] mongo user removed");
  });
  await fs.unlink(STATE_FILE).catch(() => {});
  await fs.rm(state.dir, { recursive: true, force: true }).catch(() => {});
  console.log("[test-ami] done");
}

const [, , cmd] = process.argv;
if (cmd === "start") await cmdStart();
else if (cmd === "destroy") await cmdDestroy();
else {
  console.error("Usage: node --env-file=.env.local scripts/test-ami.mjs start|destroy");
  process.exit(1);
}
