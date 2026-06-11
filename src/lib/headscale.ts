/**
 * Headscale control-plane client (mesh replacement for the reverse-SSH tunnel).
 *
 * Both the user's desktop app and their EC2 workspace join a self-hosted
 * Headscale tailnet. The backend then reaches the desktop's in-Electron
 * Playwright MCP server over MagicDNS instead of through an SSH reverse tunnel.
 *
 * This module is the single source of truth for:
 *   • node naming      — sanitizeNode() derives deterministic, DNS-safe names
 *                        from a Mongo userId. The SAME rule is reimplemented in
 *                        terraform/workspace/provision.sh; keep them identical.
 *   • Headscale users  — one namespace per platform user (`u-<node>`), which is
 *                        the per-user isolation boundary (cross-user traffic is
 *                        denied by default).
 *   • pre-auth keys    — ephemeral, single-use, tagged keys minted on demand for
 *                        a node to register with `tailscale up --authkey`.
 *
 * Env:
 *   HEADSCALE_URL      e.g. https://headscale.platform.bytescripterz.com
 *   HEADSCALE_API_KEY  a long-lived Headscale API key (created with
 *                      `headscale apikeys create`); stored in SSM Parameter
 *                      Store by the headscale box's user-data and surfaced here.
 */

/** MagicDNS base domain configured on the Headscale server (`dns.base_domain`). */
export const MAGIC_DNS_SUFFIX =
  process.env.HEADSCALE_MAGIC_DNS_SUFFIX || "ts.platform.bytescripterz.com";

/** TTL for a freshly minted pre-auth key. Short — the node registers immediately. */
const PREAUTHKEY_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getConfig(): { url: string; apiKey: string } {
  const url = process.env.HEADSCALE_URL;
  const apiKey = process.env.HEADSCALE_API_KEY;
  if (!url || !apiKey) {
    throw new Error(
      "HEADSCALE_URL and HEADSCALE_API_KEY must be set to mint mesh pre-auth keys."
    );
  }
  return { url: url.replace(/\/$/, ""), apiKey };
}

async function hsFetch(
  path: string,
  init: RequestInit & { method: string }
): Promise<Response> {
  const { url, apiKey } = getConfig();
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Deterministic, DNS-label-safe node id derived from a Mongo userId.
 * Mongo ObjectIds are hex so this is mostly a pass-through, but enforce the
 * `[a-z0-9-]` shape so it is always a valid MagicDNS hostname component.
 *
 * MUST match the `NODE=` derivation in terraform/workspace/provision.sh.
 */
export function sanitizeNode(userId: string): string {
  return String(userId)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 63);
}

export function desktopHostname(node: string): string {
  return `desktop-${node}`;
}

export function workspaceHostname(node: string): string {
  return `workspace-${node}`;
}

/** Headscale user (namespace) for a given node. */
export function userNamespace(node: string): string {
  return `u-${node}`;
}

/**
 * Ensure the per-user Headscale namespace exists. Idempotent — a 409/"already
 * exists" is treated as success so concurrent grants don't race.
 */
export async function ensureUser(node: string): Promise<void> {
  const name = userNamespace(node);
  const res = await hsFetch("/api/v1/user", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (res.ok) return;
  // Headscale returns 500/409 with an "already exists" message when the user
  // is present. Anything else is a real failure.
  const text = await res.text().catch(() => "");
  if (/already exists/i.test(text) || res.status === 409) return;
  throw new Error(`headscale ensureUser(${name}) failed: ${res.status} ${text.slice(0, 200)}`);
}

/**
 * Mint a single-use pre-auth key for `node`'s namespace. The returned key is
 * consumed once by `tailscale up --authkey=<key>`; the resulting node is owned
 * by the user namespace `u-<node>`.
 *
 * Keys are NON-ephemeral. The node persists in Headscale and its identity lives
 * in tailscaled's on-disk state, so it auto-reconnects after reboots / stop-
 * start WITHOUT needing a fresh key. (Ephemeral nodes get reaped on disconnect,
 * which broke workspaces that stop/start — the whole reason for this design.)
 * Stale duplicates after a genuine state loss (fresh instance, app reinstall)
 * are pruned by deleteOfflineNodesByName() at grant time.
 *
 * No ACL tags are used: per-user isolation comes from the namespace + the
 * per-user rule ensurePolicyRule() installs.
 */
export async function mintAuthKey(opts: {
  node: string;
  ttlMs?: number;
}): Promise<string> {
  await ensureUser(opts.node);
  await ensurePolicyRule(opts.node);
  const expiration = new Date(Date.now() + (opts.ttlMs ?? PREAUTHKEY_TTL_MS)).toISOString();
  const res = await hsFetch("/api/v1/preauthkey", {
    method: "POST",
    body: JSON.stringify({
      user: userNamespace(opts.node),
      reusable: false,
      ephemeral: false,
      expiration,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`headscale mintAuthKey failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { preAuthKey?: { key?: string } };
  const key = body.preAuthKey?.key;
  if (!key) {
    throw new Error("headscale mintAuthKey: response had no preAuthKey.key");
  }
  return key;
}

/**
 * Delete any OFFLINE Headscale nodes named `hostname`. Called before minting a
 * key so a re-registration after a real state loss (fresh EC2, app reinstall)
 * doesn't leave a stale duplicate. Only OFFLINE nodes are removed, so a live
 * connection (e.g. the app briefly reconnecting) is never killed — the online
 * node keeps its registration via its persisted machine key. Best-effort.
 */
export async function deleteOfflineNodesByName(hostname: string): Promise<void> {
  const res = await hsFetch("/api/v1/node", { method: "GET" });
  if (!res.ok) return;
  const body = (await res.json().catch(() => ({}))) as {
    nodes?: Array<{ id?: string | number; name?: string; online?: boolean }>;
  };
  const stale = (body.nodes ?? []).filter(
    (n) => n.name === hostname && n.online === false && n.id != null
  );
  for (const n of stale) {
    await hsFetch(`/api/v1/node/${n.id}`, { method: "DELETE" }).catch(() => {});
  }
}

/** Ports a user's two nodes may reach within their own namespace. */
const INTRA_USER_PORTS = "9090,8090,8080";

interface AclPolicy {
  acls?: Array<{ action: string; src: string[]; dst: string[] }>;
  [k: string]: unknown;
}

/**
 * Idempotently ensure the per-user ACL rule exists so this user's workspace
 * node can reach this user's desktop node (and vice-versa) on the MCP/service
 * ports, while every other user stays unreachable. Headscale runs in
 * policy.mode: database, so we read-modify-write the global policy via the API.
 *
 * Concurrency note: two grants for the SAME user racing both add the same rule
 * (the dedupe below makes that a no-op). Grants for DIFFERENT users racing
 * could in principle lose an update on the global PUT; product concurrency is
 * low, and a missing rule self-heals on the user's next grant. A single retry
 * covers the common transient case.
 */
export async function ensurePolicyRule(node: string): Promise<void> {
  const ns = userNamespace(node);
  const ruleKey = JSON.stringify([ns]);

  for (let attempt = 0; attempt < 2; attempt++) {
    const getRes = await hsFetch("/api/v1/policy", { method: "GET" });
    // Fresh DB-mode servers can 404/500 until a policy is first set; treat a
    // non-OK GET as "empty policy" and seed from scratch.
    let policy: AclPolicy = { acls: [] };
    if (getRes.ok) {
      const body = (await getRes.json().catch(() => ({}))) as { policy?: string };
      if (body.policy) {
        try {
          policy = JSON.parse(body.policy) as AclPolicy;
        } catch {
          policy = { acls: [] };
        }
      }
    }
    const acls = Array.isArray(policy.acls) ? policy.acls : [];
    const exists = acls.some((r) => JSON.stringify(r.src) === ruleKey);
    if (exists) return;
    acls.push({ action: "accept", src: [ns], dst: [`${ns}:${INTRA_USER_PORTS}`] });
    policy.acls = acls;

    const putRes = await hsFetch("/api/v1/policy", {
      method: "PUT",
      body: JSON.stringify({ policy: JSON.stringify(policy, null, 2) }),
    });
    if (putRes.ok) return;
    if (attempt === 1) {
      const text = await putRes.text().catch(() => "");
      throw new Error(`headscale ensurePolicyRule failed: ${putRes.status} ${text.slice(0, 200)}`);
    }
  }
}

/** The login-server URL nodes register against. */
export function loginServer(): string {
  return getConfig().url;
}
