# Traefik HTTP-provider endpoints

Both Traefik tiers (central edge + per-user) get their dynamic routing
config by polling the landing-page backend. Until these two endpoints
exist, Traefik will start up but route nothing.

Both responses are Traefik v3 [dynamic-config JSON][docs]
and **must return HTTP 200** with `content-type: application/json`. A
non-200 / parse error makes Traefik keep its previous config — adding a
broken endpoint never causes an outage on its own, but a permanently
broken endpoint drifts out of date as users churn.

[docs]: https://doc.traefik.io/traefik/providers/http/

---

## 1. `GET /api/traefik/global`

Consumed by the **central** Traefik on the edge proxy. Returns one router
+ one service per user whose workspace is currently `ready`. Each router
matches *any* subdomain under that user's domain stem.

### Implementation sketch (Next.js route)

```ts
// src/app/api/traefik/global/route.ts
import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";

const PLATFORM_DOMAIN =
  process.env.PLATFORM_DOMAIN || "platform.bytescripterz.com";

export async function GET() {
  await connectToDatabase();
  const users = await User.find({ workspaceStatus: "ready" })
    .select("_id workspace.publicDns")
    .lean();

  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  const domain = PLATFORM_DOMAIN.replace(/\./g, "\\.");

  for (const u of users) {
    const id = String(u._id);
    if (!u.workspace?.publicDns) continue;

    routers[`u-${id}`] = {
      rule: `HostRegexp(\`^[^.]+\\.${id}\\.${domain}$\`)`,
      service: `u-${id}`,
      entryPoints: ["web"],
    };
    services[`u-${id}`] = {
      loadBalancer: {
        servers: [{ url: `http://${u.workspace.publicDns}:80` }],
        passHostHeader: true,
      },
    };
  }

  return NextResponse.json(
    { http: { routers, services } },
    { headers: { "cache-control": "no-store" } }
  );
}
```

Notes:
- `passHostHeader: true` keeps the original `service1.<user>.<domain>`
  host header intact so the per-user Traefik can route on it. This is the
  whole point of the two-tier design.
- The regex deliberately matches a single label (`[^.]+`) for the service
  segment. If you ever support nested subdomains (`a.b.<user>.<domain>`)
  loosen it to `.+`.

---

## 2. `GET /api/traefik/user/:userId`

Consumed by the **per-user** Traefik on each workspace EC2. Returns the
service map for *that single user*. The three defaults (frontend, backend,
code-server) are always present; user-defined services come from whatever
collection you settle on — schema below assumes a `WorkspaceService`
model with `{ userId, name, port }`.

### Implementation sketch

```ts
// src/app/api/traefik/user/[userId]/route.ts
import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";

const PLATFORM_DOMAIN =
  process.env.PLATFORM_DOMAIN || "platform.bytescripterz.com";

const DEFAULT_SERVICES = [
  { name: "frontend", port: 3000 },
  { name: "api",      port: 8090 },
  { name: "ide",      port: 8080 },
];

export async function GET(
  _req: Request,
  { params }: { params: { userId: string } }
) {
  const { userId } = params;
  await connectToDatabase();

  const user = await User.findById(userId)
    .select("workspaceStatus")
    .lean();
  if (!user || user.workspaceStatus !== "ready") {
    return NextResponse.json(
      { http: { routers: {}, services: {} } },
      { headers: { "cache-control": "no-store" } }
    );
  }

  // TODO: replace with a real lookup from a WorkspaceService collection.
  const userServices: Array<{ name: string; port: number }> = [];

  const all = [...DEFAULT_SERVICES, ...userServices];
  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  const host = `${userId}.${PLATFORM_DOMAIN}`;

  for (const svc of all) {
    routers[svc.name] = {
      rule: `Host(\`${svc.name}.${host}\`)`,
      service: svc.name,
      entryPoints: ["web"],
    };
    services[svc.name] = {
      loadBalancer: {
        servers: [{ url: `http://127.0.0.1:${svc.port}` }],
      },
    };
  }

  return NextResponse.json(
    { http: { routers, services } },
    { headers: { "cache-control": "no-store" } }
  );
}
```

This endpoint is hit from each user's EC2 every `config_poll_seconds`
(default 5s). With N users that's roughly `N / 5` req/s of trivial DB
reads — well under a single Mongo connection. If it ever becomes a
hotspot, cache by `userId` for ~2s.

---

## Auth

Both endpoints should be **unauthenticated** but firewalled where
practical:

- `/api/traefik/global` — only the central proxy EC2 hits it. Optionally
  allowlist the proxy EC2's elastic IP at the CDN/WAF layer.
- `/api/traefik/user/:userId` — hit from arbitrary user EC2 public IPs.
  Add a shared secret in a header (`X-Traefik-Token`) if you want a low-
  effort gate — Traefik HTTP provider supports custom headers via the
  static config (`providers.http.headers`).

Neither endpoint returns secrets, only public hostnames + ports, so the
worst case from leakage is enumeration.

---

## Required env on the Next.js server

| Var | Example | Purpose |
|---|---|---|
| `PLATFORM_DOMAIN` | `platform.bytescripterz.com` | Used to build the per-user host stem in both endpoints |
| `TRAEFIK_CONFIG_BASE_URL` | `https://platform.bytescripterz.com/api/traefik/user` | What each user EC2's Traefik is wired to poll. `src/lib/workspace.ts` appends `/<userId>` and passes it in via tfvars at apply time |
