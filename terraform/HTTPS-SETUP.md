# Enabling HTTPS

Adds TLS to the platform via AWS ACM + an HTTPS listener on the ALB.
Free, auto-renewing, no certbot to babysit. AWS terminates TLS at the
ALB; the proxy chain inside (ALB → Traefik → user Traefik → app) stays
on plain HTTP — that traffic is internal and fine.

## Prerequisites

- Cert covers `platform.bytescripterz.com` + `*.platform.bytescripterz.com`.
- Validation is by DNS — ACM gives you a CNAME to add in Namecheap.
- Wait ~5 minutes for the cert to validate. ALB listener creation is fast.

## Step-by-step

### 1. Apply the cert request only

This creates the ACM cert and tells you the validation CNAME to add. It
does NOT touch the ALB listener yet, so existing HTTP traffic keeps
flowing.

```bash
cd terraform/proxy
terraform apply -target=aws_acm_certificate.platform \
  -var enable_https=true \
  -var region=us-west-2 \
  -var platform_domain=platform.bytescripterz.com \
  -var "mongodb_uri=$MONGODB_URI"
```

### 2. Read the validation records

```bash
terraform output acm_validation_records
```

You'll get something like:

```hcl
[
  {
    domain           = "platform.bytescripterz.com"
    record_name_fqdn = "_a1b2c3d4.platform.bytescripterz.com"
    record_value     = "_e5f6g7h8.acm-validations.aws"
    record_type      = "CNAME"
  },
]
```

ACM usually emits one CNAME that covers both the apex and the wildcard
SAN (since they share the parent zone).

### 3. Add the CNAME in Namecheap

Namecheap → bytescripterz.com → **Advanced DNS** → **Add New Record**:

| Type | Host | Value | TTL |
|---|---|---|---|
| `CNAME Record` | `_a1b2c3d4.platform` | `_e5f6g7h8.acm-validations.aws` | Automatic |

> **Important:** Namecheap's Host field is *relative to the zone*, so
> drop the `.bytescripterz.com` suffix when typing the Host. Leave the
> Value as the full FQDN. Don't include trailing dots — Namecheap adds
> them for you.

Save. Propagation: 1–5 min on Automatic TTL.

### 4. Finish the apply

```bash
terraform apply \
  -var enable_https=true \
  -var region=us-west-2 \
  -var platform_domain=platform.bytescripterz.com \
  -var "mongodb_uri=$MONGODB_URI"
```

What happens:

- `aws_acm_certificate_validation` polls ACM until the cert is ISSUED
  (usually within 1–2 minutes once DNS resolves; up to 30 min worst-case).
- The HTTPS listener gets attached to the ALB on `:443`.
- The HTTP listener on `:80` switches from `forward` to `301 redirect`
  to `https://`.
- The traefik-router on the proxy EC2 starts emitting `https://` URLs
  (the cloud-init on the proxy EC2 is re-rendered with `PLATFORM_PROTOCOL=https`).

If `terraform apply` hangs at `Still creating...` on
`aws_acm_certificate_validation`, it's waiting for DNS. Open another
shell:

```bash
dig CNAME _a1b2c3d4.platform.bytescripterz.com +short
# should print _e5f6g7h8.acm-validations.aws
```

If `dig` returns the right value, ACM will validate within a minute.
If not, your Namecheap record hasn't propagated yet.

### 5. Flip the landing-page env

In `.env.local` of the landing-page repo:

```env
PLATFORM_PROTOCOL=https
```

Restart the Next.js process. From now on, every newly provisioned
workspace gets `https://` URLs baked into its frontend env. Existing
workspaces still emit HTTP URLs in their `NEXT_PUBLIC_*` — see migration
below.

### 6. Migrate any running workspaces

Two options.

**Option A — re-provision (cleanest):** destroy + recreate via the
dashboard. The new EC2 boots with `PLATFORM_PROTOCOL=https` in its
`/etc/workspace.env`.

**Option B — in-place patch:** SSH/Instance-Connect into the workspace
EC2 and update env + restart frontend:

```bash
echo "PLATFORM_PROTOCOL=https" | sudo tee -a /etc/workspace.env
sudo sed -i 's|http://api-|https://api-|; s|http://ide-|https://ide-|' \
  /etc/systemd/system/ai-ide-frontend.service
sudo systemctl daemon-reload
sudo systemctl restart ai-ide-frontend
```

## Disabling HTTPS (rollback)

```bash
terraform apply -var enable_https=false ...
```

- HTTPS listener gets destroyed.
- HTTP listener flips back to `forward`.
- ACM cert remains (free; safe to keep for later).

You'll also want to set `PLATFORM_PROTOCOL=http` in `.env.local` and
restart Next.js.

## Costs

- ACM cert: $0 (free).
- HTTPS listener: same per-LCU rate as HTTP; no additional fixed fee.
- TLS termination is included in ALB pricing.

Net add: $0/mo.
