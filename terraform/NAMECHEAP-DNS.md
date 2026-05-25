# Namecheap DNS setup

`*.platform.bytescripterz.com` must resolve to the AWS ALB created by
`terraform/proxy/`. Below is the exact record list to add in Namecheap.

> Assumes `bytescripterz.com` is the zone you manage in Namecheap. If
> `platform.bytescripterz.com` is itself a delegated zone (separate NS
> records), you'd be adding these under that zone instead.

## Steps

1. Sign in to Namecheap → Domain List → **bytescripterz.com** → **Manage**
   → **Advanced DNS** tab.
2. Click **Add New Record** and create the two rows below — these are the
   **real values** from the current `terraform/proxy/` apply:

| Type | Host | Value | TTL |
|---|---|---|---|
| `CNAME Record` | `*.platform` | `ai-proxy-2027330005.us-west-2.elb.amazonaws.com` | Automatic |
| `CNAME Record` | `platform`   | `ai-proxy-2027330005.us-west-2.elb.amazonaws.com` | Automatic |

> Do **not** include a trailing dot in the Value field — Namecheap adds
> it for you. And do **not** wrap in quotes.

These two records cover every per-user URL, e.g.
`frontend-<userId>.platform.bytescripterz.com`,
`api-<userId>.platform.bytescripterz.com`, etc. — the dash-separator
scheme keeps every subdomain one DNS label deep so Namecheap's flat
wildcard match is sufficient.

4. Save. Propagation is usually under 5 minutes on Automatic TTL.
5. Test:
   ```bash
   nslookup frontend-anything.platform.bytescripterz.com
   # → CNAME ai-proxy-…elb.amazonaws.com
   ```

## Why CNAME, not A

The ALB doesn't have a stable IP — AWS rotates the backend IPs. The
hostname is the only thing you can safely point at. (Route53 ALIAS lets
you "fake" an A record on an apex, but Namecheap doesn't support it.)

## After DNS is live

1. Open `frontend-anything.platform.bytescripterz.com` — should show
   Traefik's 404 page (no users provisioned yet, so no routes match —
   expected).
2. Provision a user via the dashboard.
3. Open `frontend-<userId>.platform.bytescripterz.com` — should hit the
   AI-IDE frontend.
