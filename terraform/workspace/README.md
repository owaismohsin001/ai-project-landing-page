# Workspace Terraform module

Provisions one isolated AWS workspace per subscriber:

| Resource | Notes |
|---|---|
| **EC2 instance** | Ubuntu 24.04 LTS (Noble), sized by plan (see below), public IP, gp3 root |
| **S3 bucket** | Private, AES-256 SSE, force-destroy on `terraform destroy` |
| **Security group** | All ports / all protocols open to `var.ingress_cidr` (default `0.0.0.0/0` — see warning below) |
| **IAM user + access key** | Scoped to *this* instance, SG, and bucket |
| **Workspace HTTP server (`:9099`)** | Installed by `user-data.sh.tftpl` — backup/restore control plane |
| **Per-user Traefik (`:80`)** | Docker container installed by `user-data.sh.tftpl`. Reads dynamic routes from the landing-page backend via the HTTP provider |
| **AI-IDE stack** | Installed by `cloud-init.sh` — Claude Code CLI, code-server (`:8080`), AI-IDE backend (`:8090`), AI-IDE frontend (`:3000`) |

## Routing

The frontend used to bind `:80` directly. It now binds `:3000` and Traefik
owns `:80`, fronting every service on the box:

```
            ┌───────────────────────────────────────────────────────────────┐
            │  AWS ALB (terraform/proxy)                                    │
            │       │                                                       │
            │       ▼   *-{user_id}.{platform_domain}                       │
            │  Central Traefik EC2                                          │
            │       │                                                       │
   ╔════════╪═══════▼═══════════════════════════════════════════════════════╪═══╗
   ║        │  Per-user EC2  (THIS module)                                  │   ║
   ║        ▼                                                               │   ║
   ║  Traefik :80   ──►  frontend-{user_id}.{platform_domain}  → :3000      │   ║
   ║                ──►  api-{user_id}.{platform_domain}       → :8090      │   ║
   ║                ──►  ide-{user_id}.{platform_domain}       → :8080      │   ║
   ║                ──►  <anything>-{user_id}.{platform_domain} → user port │   ║
   ╚═══════════════════════════════════════════════════════════════════════════╝
```

Per-user Traefik fetches its dynamic config every `var.config_poll_seconds`
from `var.backend_config_url` (the proxy EC2's traefik-router). Dash-
separator subdomains keep every URL one DNS label deep so Namecheap's
flat `*.platform.bytescripterz.com` wildcard covers every user.

The workspace HTTP server (`server/server.js`) exposes:
- `GET  /health` — liveness + identity
- `GET  /snapshots` — list snapshots for this instance
- `POST /backup` — snapshot every attached EBS volume
- `POST /restore` — body `{ snapshotId, device? }` — create volume from snapshot and attach

The AI-IDE stack is bootstrapped by `cloud-init.sh` after the workspace
server is up. Logs at `/var/log/ai-ide-install.log` on the instance.

## Inputs

| Variable | Type | Description |
|---|---|---|
| `region` | string | AWS region |
| `user_id` | string | Stable user id (4-40 chars, `[a-z0-9-]`) |
| `instance_type` | string | EC2 type — see plan mapping in `src/lib/workspace.ts` |
| `name_prefix` | string | Resource-name prefix (default `ai-workspace`) |
| `ingress_cidr` | string | CIDR allowed on 22/9099 (default `0.0.0.0/0`) |
| `platform_domain` | string | Apex domain, e.g. `platform.bytescripterz.com` |
| `backend_config_url` | string | HTTP-provider URL for THIS user's service map (must already contain the user id) |
| `config_poll_seconds` | number | Traefik HTTP-provider poll interval (default 5) |

## Outputs

`instance_id`, `instance_public_ip`, `instance_public_dns`, `bucket_name`,
`security_group_id`, `iam_user_name`, `iam_access_key_id` (sensitive),
`iam_secret_access_key` (sensitive), `workspace_url`.

## Plan → instance type mapping

Set in `src/lib/workspace.ts`. Defaults (us-west-2 on-demand approx):

| Plan | Price | Instance | EC2 cost | Margin |
|---|---|---|---|---|
| Starter | $20 / mo | t3.micro  | ~$7.50  | ~$12.50 |
| Pro     | $60 / mo | t3.small  | ~$15.20 | ~$44.80 |
| Premium | $200 / mo | t3.medium | ~$30.40 | ~$169.60 |

Margins also have to absorb S3 storage, data transfer, snapshots, and IAM.

## Standalone use

```bash
cd terraform/workspace
terraform init
terraform apply \
  -var region=us-west-2 \
  -var user_id=demo-001 \
  -var instance_type=t3.micro
```

When called from the app, each user gets a per-user state directory at
`terraform/workspaces/<userId>/` so concurrent users don't share state.
