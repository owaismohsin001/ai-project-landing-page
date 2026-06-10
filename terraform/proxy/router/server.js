"use strict";

const fs = require("node:fs");
const nodePath = require("node:path");

/**
 * Traefik HTTP-provider router.
 *
 * Two read-only endpoints used by both Traefik tiers to discover routes:
 *
 *   GET /api/traefik/global          → routes for the central edge proxy.
 *                                       One router/service per user whose
 *                                       workspaceStatus === "ready".
 *
 *   GET /api/traefik/user/:userId    → routes for one user's per-EC2 Traefik.
 *                                       Always includes frontend/api/ide;
 *                                       plus anything in workspaceservices.
 *
 * Both responses are Traefik v3 dynamic-config JSON. Polled every ~5s by
 * Traefik; failures cause Traefik to keep the previous config, so a
 * temporary blip here is not user-visible — but a permanent break drifts.
 */

const http = require("node:http");
const { MongoClient } = require("mongodb");
const { execFile } = require("node:child_process");

const PORT = Number(process.env.PORT || 9100);
const MONGODB_URI = process.env.MONGODB_URI;
const PLATFORM_DOMAIN =
  process.env.PLATFORM_DOMAIN || "platform.bytescripterz.com";
// http or https — flipped by the proxy module's enable_https var. The
// scheme only affects URLs we emit to clients (the browser); internal
// traffic (Traefik polling the router) stays on plain HTTP.
const PLATFORM_PROTOCOL = (process.env.PLATFORM_PROTOCOL || "http").toLowerCase();

if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set — refusing to start.");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI, {
  serverSelectionTimeoutMS: 8000,
  // The landing page uses the legacy ai-landing DB. Pull it from the URI.
});

let db = null;
let mongoReady = client
  .connect()
  .then((c) => {
    db = c.db();
    console.log("mongo: connected to", db.databaseName);
  })
  .catch((err) => {
    console.error("mongo: initial connect failed", err);
    // Keep the promise rejected so requests fail fast until reconnect.
    mongoReady = Promise.reject(err);
  });

// Default services every workspace gets, even if no WorkspaceService docs
// exist. Subdomains land on these via per-user Traefik.
//
// docs/sheets host pre-installed ONLYOFFICE Docs Server instances (DOCX
// editor on :4000, XLSX on :4001). docs-agent/sheets-agent are the
// Playwright-driven headless co-editor sidecars that hold each service's
// AI-attributed editing session and bridge MCP tool calls into the
// Asc.plugin.callCommand API over WebSocket.
const DEFAULT_SERVICES = [
  { name: "frontend", port: 3000 },
  { name: "api", port: 8090 },
  { name: "ide", port: 8080 },
  { name: "docs", port: 4000 },
  { name: "sheets", port: 4001 },
  { name: "docs-agent", port: 4100 },
  { name: "sheets-agent", port: 4101 },
];

// Ports owned by the workspace runtime itself — never register these as
// user services. 80 = per-user Traefik, 8081 = Traefik ping, 9099 =
// workspace HTTP server (backup/restore), 4000/4001 = ONLYOFFICE Docs
// Server (docs/sheets), 4100/4101 = the docs-agent/sheets-agent sidecars.
const RESERVED_PORTS = new Set([80, 8081, 9099, 4000, 4001, 4100, 4101]);

function defaultServiceForPort(port) {
  return DEFAULT_SERVICES.find((s) => s.port === port) ?? null;
}

function serviceUrl(name, userId) {
  return `${PLATFORM_PROTOCOL}://${name}-${userId}.${PLATFORM_DOMAIN}`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function emptyConfig() {
  return { http: { routers: {}, services: {} } };
}

/**
 * Build the global config — every ready user gets one HostRegexp router
 * pointing at their EC2's public DNS on :80 (where the per-user Traefik
 * lives). passHostHeader: true keeps the original
 * <service>-<userId>.<platform> host header intact so the per-user
 * Traefik can route on it.
 *
 * The dash-separator scheme keeps everything one DNS label deep, which
 * means Namecheap's flat `*.<platform>` wildcard CNAME covers every user
 * with no per-user DNS records.
 */
async function buildGlobalConfig() {
  await mongoReady;
  const users = await db
    .collection("users")
    .find(
      { workspaceStatus: "ready", "workspace.publicDns": { $exists: true } },
      { projection: { _id: 1, "workspace.publicDns": 1 } }
    )
    .toArray();

  const domain = escapeRegex(PLATFORM_DOMAIN);
  const routers = {};
  const services = {};

  for (const u of users) {
    const id = String(u._id);
    const dns = u.workspace && u.workspace.publicDns;
    if (!dns) continue;

    // Matches anything-ending-in -<userId>.<domain>: frontend-<id>.<domain>,
    // api-<id>.<domain>, custom-app-<id>.<domain>, etc.
    routers[`u-${id}`] = {
      rule: `HostRegexp(\`^.+-${escapeRegex(id)}\\.${domain}$\`)`,
      service: `u-${id}`,
      entryPoints: ["web"],
    };
    services[`u-${id}`] = {
      loadBalancer: {
        servers: [{ url: `http://${dns}:80` }],
        passHostHeader: true,
      },
    };
  }

  return { http: { routers, services } };
}

/**
 * Build the per-user config — defaults + anything users have added in the
 * workspaceservices collection. If the user is not provisioned (or not
 * ready), return an empty config so Traefik just 404s — better than
 * letting it serve stale routes.
 */
async function buildUserConfig(userId) {
  await mongoReady;
  if (!/^[a-f0-9]{24}$/i.test(userId)) return emptyConfig();

  const { ObjectId } = require("mongodb");
  const user = await db
    .collection("users")
    .findOne(
      { _id: new ObjectId(userId) },
      { projection: { workspaceStatus: 1 } }
    );
  if (!user || user.workspaceStatus !== "ready") return emptyConfig();

  const extra = await db
    .collection("workspaceservices")
    .find({ userId: new ObjectId(userId) }, { projection: { name: 1, port: 1 } })
    .toArray();

  const seen = new Set();
  const all = [];
  for (const svc of [...DEFAULT_SERVICES, ...extra]) {
    if (!svc.name || !svc.port) continue;
    if (seen.has(svc.name)) continue; // user-defined services can't shadow defaults
    seen.add(svc.name);
    all.push({ name: svc.name, port: Number(svc.port) });
  }

  const routers = {};
  const services = {};

  // Services whose responses must be iframe-embeddable from any origin.
  // ONLYOFFICE Docs Server sends `X-Frame-Options: SAMEORIGIN` by default,
  // which blocks the frontend (frontend-<userId>...) from iframing the
  // editor — and the design here is that the user opens documents inside
  // the workspace shell, not by navigating to docs-<userId>... directly.
  // Stripping the header at Traefik is portable across ONLYOFFICE versions
  // (env vars for this are inconsistent) and targets only these two
  // services without broadly relaxing headers for the whole workspace.
  const IFRAME_ANYORIGIN_SERVICES = new Set(["docs", "sheets"]);

  for (const svc of all) {
    const router = {
      rule: `Host(\`${svc.name}-${userId}.${PLATFORM_DOMAIN}\`)`,
      service: svc.name,
      entryPoints: ["web"],
    };
    if (IFRAME_ANYORIGIN_SERVICES.has(svc.name)) {
      router.middlewares = ["office-iframe-anyorigin"];
    }
    routers[svc.name] = router;
    services[svc.name] = {
      loadBalancer: {
        servers: [{ url: `http://127.0.0.1:${svc.port}` }],
      },
    };
  }

  // Empty-string value in customResponseHeaders removes the header
  // upstream emitted. Leaving Content-Security-Policy untouched so any
  // legitimate CSP from ONLYOFFICE (e.g. anti-XSS for document content)
  // still applies — modern ONLYOFFICE doesn't restrict frame-ancestors
  // via CSP by default. If we ever see iframe blocking from CSP after
  // X-Frame-Options is gone, add `"Content-Security-Policy": ""` here.
  const middlewares = {
    "office-iframe-anyorigin": {
      headers: {
        customResponseHeaders: {
          "X-Frame-Options": "",
        },
      },
    },
  };

  return { http: { routers, services, middlewares } };
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * List all services (defaults + user-defined) for a user, as clean JSON.
 * The user EC2's backend uses this to display the services view; it's not
 * polled by Traefik (Traefik uses /api/traefik/user/:userId instead).
 */
async function listServices(userId) {
  await mongoReady;
  if (!/^[a-f0-9]{24}$/i.test(userId)) return [];

  const { ObjectId } = require("mongodb");
  const extra = await db
    .collection("workspaceservices")
    .find({ userId: new ObjectId(userId) }, { projection: { name: 1, port: 1 } })
    .toArray();

  const seen = new Set();
  const all = [];
  for (const svc of [...DEFAULT_SERVICES, ...extra]) {
    if (!svc.name || !svc.port) continue;
    if (seen.has(svc.name)) continue; // defaults win over user-defined
    seen.add(svc.name);
    all.push({
      name: svc.name,
      port: Number(svc.port),
      url: serviceUrl(svc.name, userId),
    });
  }
  return all;
}

/**
 * Register a service idempotently. Resolution order:
 *   1. Port is reserved (80 / 8081 / 9099) → 400.
 *   2. Port matches a default (3000 / 8090 / 8080) → return that default,
 *      no DB write.
 *   3. WorkspaceService already exists for (userId, port) → return it.
 *   4. Otherwise insert with name=providedName ?? `port-<port>`.
 *
 * Returns { name, port, url }. Safe to call repeatedly for the same port.
 */
async function registerService(userId, body) {
  await mongoReady;
  if (!/^[a-f0-9]{24}$/i.test(userId)) {
    return { status: 400, body: { error: "invalid userId" } };
  }

  const port = Number(body && body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 400, body: { error: "port must be an integer 1-65535" } };
  }
  if (RESERVED_PORTS.has(port)) {
    return { status: 400, body: { error: `port ${port} is reserved by the workspace runtime` } };
  }

  const fromDefault = defaultServiceForPort(port);
  if (fromDefault) {
    return {
      status: 200,
      body: { name: fromDefault.name, port, url: serviceUrl(fromDefault.name, userId) },
    };
  }

  const { ObjectId } = require("mongodb");
  const oid = new ObjectId(userId);
  const services = db.collection("workspaceservices");

  const existing = await services.findOne({ userId: oid, port });
  if (existing) {
    return {
      status: 200,
      body: { name: existing.name, port, url: serviceUrl(existing.name, userId) },
    };
  }

  // Default name = port-<port>. If the caller provided a name, validate +
  // use it; otherwise generate.
  let name =
    body && typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  if (!name) name = `port-${port}`;
  if (!/^[a-z0-9-]{1,32}$/.test(name)) {
    return {
      status: 400,
      body: { error: "name must be 1-32 chars of [a-z0-9-]" },
    };
  }
  if (DEFAULT_SERVICES.some((s) => s.name === name)) {
    return {
      status: 409,
      body: { error: `name "${name}" is reserved` },
    };
  }

  try {
    await services.insertOne({ userId: oid, name, port, createdAt: new Date() });
  } catch (err) {
    // Duplicate (userId, name) — another caller raced us. Re-fetch.
    if (err && err.code === 11000) {
      const after = await services.findOne({ userId: oid, name });
      if (after) {
        return {
          status: 200,
          body: { name: after.name, port: after.port, url: serviceUrl(after.name, userId) },
        };
      }
    }
    throw err;
  }

  return {
    status: 201,
    body: { name, port, url: serviceUrl(name, userId) },
  };
}

// -- live DNS self-heal --------------------------------------------
// An EC2 public DNS/IP changes on every stop/start. Instead of trusting
// whatever publicDns was stored at provision time, every
// DNS_SYNC_INTERVAL_MS we describe each ready user instance (keyed by
// the STABLE instanceId) and write the live publicDns/publicIp back into
// Mongo. buildGlobalConfig (edge routing) and the landing backend
// /api/desktop/tunnel-grant (the desktop MCP tunnel target) both read
// those fields, so this single loop keeps everything pointed at the right
// box after a stop/start or an AMI relaunch -- no per-workspace secrets
// or boot scripts required. Needs the AWS CLI on PATH and an instance
// role granting ec2:DescribeInstances (see proxy main.tf / user-data).
const AWS_BIN = process.env.AWS_BIN || "/usr/local/bin/aws";
const AWS_REGION = process.env.AWS_REGION || "us-west-2";
const DNS_SYNC_INTERVAL_MS = Number(process.env.DNS_SYNC_INTERVAL_MS || 30000);

function describeInstances(instanceIds) {
  return new Promise((resolve, reject) => {
    const args = ["ec2", "describe-instances", "--region", AWS_REGION,
      // --filters (not --instance-ids) so a since-terminated id does not
      // fail the whole batch with InvalidInstanceID.NotFound.
      "--filters", "Name=instance-id,Values=" + instanceIds.join(","),
      "--query", "Reservations[].Instances[].[InstanceId,PublicDnsName,PublicIpAddress,State.Name]",
      "--output", "json"];
    execFile(AWS_BIN, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout || "[]")); } catch (e) { reject(e); }
    });
  });
}

async function syncWorkspaceDns() {
  try {
    await mongoReady;
    const users = await db.collection("users").find(
      { workspaceStatus: "ready", "workspace.instanceId": { $exists: true } },
      { projection: { "workspace.instanceId": 1, "workspace.publicDns": 1, "workspace.publicIp": 1 } }
    ).toArray();
    const ids = users.map((u) => u.workspace && u.workspace.instanceId).filter(Boolean);
    if (!ids.length) return;
    const rows = await describeInstances(ids);
    const live = new Map();
    for (const r of rows) {
      const iid = r[0], dns = r[1], ip = r[2], state = r[3];
      if (state === "running" && dns) live.set(iid, { dns, ip: ip || "" });
    }
    let fixed = 0;
    for (const u of users) {
      const iid = u.workspace && u.workspace.instanceId;
      const cur = live.get(iid);
      if (!cur) continue;
      if ((u.workspace.publicDns || "") !== cur.dns || (u.workspace.publicIp || "") !== cur.ip) {
        await db.collection("users").updateOne(
          { _id: u._id },
          { $set: { "workspace.publicDns": cur.dns, "workspace.publicIp": cur.ip } }
        );
        fixed++;
        console.log("dns-sync: " + u._id + " -> " + cur.dns + " (" + cur.ip + ")");
      }
    }
    if (fixed) console.log("dns-sync: updated " + fixed + " workspace(s)");
  } catch (err) {
    console.error("dns-sync: failed:", err.message);
  }
}

void syncWorkspaceDns();
setInterval(() => { void syncWorkspaceDns(); }, DNS_SYNC_INTERVAL_MS);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      jsonResponse(res, 200, { ok: true, db: db ? db.databaseName : null });
      return;
    }

    if (req.method === "GET" && path === "/api/traefik/global") {
      const cfg = await buildGlobalConfig();
      jsonResponse(res, 200, cfg);
      return;
    }

    let m = path.match(/^\/api\/traefik\/user\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === "GET") {
      const cfg = await buildUserConfig(m[1]);
      jsonResponse(res, 200, cfg);
      return;
    }

    m = path.match(/^\/api\/services\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === "GET") {
      const services = await listServices(m[1]);
      jsonResponse(res, 200, { services });
      return;
    }
    if (m && req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        jsonResponse(res, 400, { error: "invalid json body" });
        return;
      }
      const result = await registerService(m[1], body);
      jsonResponse(res, result.status, result.body);
      return;
    }

    // Static-file bootstrap endpoint. Serves the workspace provision.sh
    // (and any other small bootstrap script we drop alongside) so per-user
    // EC2s don't have to embed it in their own user-data. Limited to a
    // strict allow-list of filenames to prevent path traversal.
    //
    // provision.sh is the per-instance tail that runs on every new EC2
    // launched from the workspace AMI; cloud-init.sh is kept on disk for
    // any pre-AMI-cutover instances that still curl the old name (drop
    // safely after a few weeks of no traffic).
    const sm = path.match(/^\/bootstrap\/([A-Za-z0-9_.-]+)$/);
    if (sm && req.method === "GET") {
      const allowed = new Set(["provision.sh", "cloud-init.sh"]);
      if (!allowed.has(sm[1])) {
        jsonResponse(res, 404, { error: "not found" });
        return;
      }
      try {
        const filePath = nodePath.join("/opt/traefik-router/bootstrap", sm[1]);
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": data.length,
          "cache-control": "no-store",
        });
        res.end(data);
      } catch {
        jsonResponse(res, 404, { error: "not found" });
      }
      return;
    }

    jsonResponse(res, 404, { error: "not found" });
  } catch (err) {
    console.error("request failed", err);
    jsonResponse(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`traefik-router listening on :${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`${sig} — shutting down`);
    server.close(() => client.close().finally(() => process.exit(0)));
  });
}
