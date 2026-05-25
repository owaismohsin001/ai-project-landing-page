# Edge proxy (central Traefik + in-box routing brain)

Stands up the **always-on** edge layer that fronts every user workspace.
Self-contained — the proxy EC2 also runs the small `traefik-router` Node
service that both Traefik tiers poll for dynamic config.

```
Namecheap DNS  *.platform.bytescripterz.com  ──►  ALB hostname (CNAME)
                                                          │
                                                          ▼
                                                  AWS ALB  :80
                                                          │
                                                          ▼
                                ┌──────────────────────────────────────────┐
                                │  Proxy EC2                               │
                                │  ┌─────────────────┐  ┌────────────────┐ │
                                │  │ Traefik  :80    │◄─┤ router :9100   │ │
                                │  │ (HTTP provider) │  │ Node + Mongo   │ │
                                │  └────────┬────────┘  └────────────────┘ │
                                └───────────┼──────────────────────────────┘
                                            │
                       (proxies *.<user>.<domain> to that user's EC2:80)
                                            ▼
                                Per-user EC2 (workspace module)
                                  Traefik polls http://<proxy-dns>:9100/api/traefik/user/<id>
```

## Inputs

| Variable | Notes |
|---|---|
| `region` | AWS region |
| `platform_domain` | Apex domain (e.g. `platform.bytescripterz.com`) |
| `mongodb_uri` | Connection string for the same Mongo the landing page uses (sensitive) |
| `name_prefix` | Resource-name prefix (default `ai-proxy`) |
| `instance_type` | EC2 size (default `t3.small`) |
| `router_port` | Router HTTP port (default `9100`) |
| `config_poll_seconds` | Traefik poll interval (default `5`) |
| `ingress_cidr` | CIDR for ALB ingress (default `0.0.0.0/0`) |

## Apply

```bash
cd terraform/proxy
terraform init
terraform apply \
  -var region=us-west-2 \
  -var platform_domain=platform.bytescripterz.com \
  -var mongodb_uri='mongodb+srv://…/ai-landing?…'
```

Outputs you care about:

| Output | Use |
|---|---|
| `alb_dns_name` | DNS target for `*.platform.bytescripterz.com` (Namecheap CNAME) |
| `router_base_url` | Set as `TRAEFIK_ROUTER_BASE_URL` in the landing page's `.env.local` |

## Subdomain scheme

All per-user URLs are `<service>-<userId>.<platform_domain>`:

| URL | Routes to |
|---|---|
| `frontend-<userId>.platform.bytescripterz.com` | user's EC2 → :3000 |
| `api-<userId>.platform.bytescripterz.com`      | user's EC2 → :8090 |
| `ide-<userId>.platform.bytescripterz.com`      | user's EC2 → :8080 |
| `<custom>-<userId>.platform.bytescripterz.com` | user's EC2 → user-defined port |

Dash-separator (not dot) is deliberate: every host is one DNS label deep,
so a single flat `*.platform.bytescripterz.com` CNAME in Namecheap is
enough. No Route 53, no per-user DNS, no nested wildcards.

## How discovery works

- **Central Traefik** polls `http://127.0.0.1:9100/api/traefik/global` every 5s.
  The router queries `users` for any doc with `workspaceStatus === "ready"`
  and a `workspace.publicDns`, then emits a HostRegexp router per user that
  matches `^.+-<userId>\.<domain>$` and forwards to that user's EC2.
- **Per-user Traefik** (on each workspace EC2) polls
  `http://<proxy-dns>:9100/api/traefik/user/<userId>`. The router merges
  the three default services (frontend/api/ide) with any docs in the
  `workspaceservices` collection, emitting one `Host()` route per service.

A user adds a service by inserting `{ userId, name, port }` into
`workspaceservices` (via POST /api/workspace/services). The next poll
(≤5s) picks it up; no SSH, no apply.

## TLS later

`traefik.yml.tftpl` exposes only `web` (`:80`). To add TLS:

1. Issue an ACM wildcard for `*.platform.bytescripterz.com`.
2. Add an HTTPS listener on the ALB attached to the cert.
3. Traefik stays on plain `:80` — TLS terminates at the ALB.
