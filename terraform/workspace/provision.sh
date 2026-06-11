#!/usr/bin/env bash
#
# AI-IDE Studio — per-instance provisioning script
#
# This is the SHORT tail that runs on every new EC2 instance launched
# from the workspace AMI. The AMI (built by bake.sh) already contains
# all the heavy lifting — apt deps, Node, Claude CLI, code-server,
# Docker + Playwright + ONLYOFFICE images, the AI-IDE backend/frontend
# repos with node_modules, every systemd unit, etc.
#
# This script just does the per-user setup:
#   1. Re-source /etc/workspace.env (user-data.sh.tftpl rewrote it with
#      the new user's USER_ID / AWS keys / OFFICE_JWT_SECRET / etc.)
#   2. git pull --ff-only the backend + frontend repos so even old AMIs
#      pick up commits made since the bake. Re-run npm install only if
#      package-lock.json actually changed.
#   3. Reset ONLYOFFICE postgres + session state so it accepts the new
#      OFFICE_JWT_SECRET (the AMI's state is tied to the source's secret).
#   4. Write ~ubuntu/.claude/CLAUDE.md with this instance's URLs.
#   5. Restart per-instance services so they pick up the fresh
#      /etc/workspace.env.
#   6. Print final summary with the per-user URLs.
#
# Hosted at ${PROXY_ROUTER_URL}/bootstrap/provision.sh; user-data.sh.tftpl
# downloads + executes it. Run as root.
#
# Logs land in /var/log/ai-ide-provision.log — tail -f it to watch.

set -euo pipefail

export HOME="${HOME:-/root}"

readonly LOG_FILE="/var/log/ai-ide-provision.log"
mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

# Colors / log helpers (kept inline so this script has no external deps).
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
CYAN=$'\033[0;36m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
NC=$'\033[0m'

ts()    { date '+%H:%M:%S'; }
log()   { echo "${BLUE}▸${NC} ${DIM}[$(ts)]${NC} $*"; }
ok()    { echo "${GREEN}✓${NC} ${DIM}[$(ts)]${NC} ${GREEN}$*${NC}"; }
warn()  { echo "${YELLOW}!${NC} ${DIM}[$(ts)]${NC} ${YELLOW}$*${NC}"; }
err()   { echo "${RED}✗${NC} ${DIM}[$(ts)]${NC} ${RED}$*${NC}" >&2; }
hdr()   { echo; echo "${BOLD}${CYAN}═══════════════════════════════════════════════${NC}"; \
          echo "${BOLD}${CYAN}  $*${NC}"; \
          echo "${BOLD}${CYAN}═══════════════════════════════════════════════${NC}"; }

if [ "$(id -u)" != "0" ]; then
  err "provision.sh must run as root."
  exit 1
fi

# ── Sanity check: this is supposed to run on a baked AMI ─────────────
if [ ! -f /etc/ai-ide-ami-version ]; then
  err "/etc/ai-ide-ami-version missing — this instance does NOT look like"
  err "it was launched from a baked workspace AMI. provision.sh assumes"
  err "every install step in bake.sh has already run."
  err "If you're bootstrapping a fresh EC2, run bake.sh first."
  exit 1
fi
log "Baked AMI version: $(cat /etc/ai-ide-ami-version)"

# ── Identity from /etc/workspace.env (just rewritten by user-data) ───
if [ ! -f /etc/workspace.env ]; then
  err "/etc/workspace.env missing — user-data.sh.tftpl should have written it"
  exit 1
fi
set -a
# shellcheck disable=SC1091
. /etc/workspace.env
set +a

if [ -z "${USER_ID:-}" ] || [ -z "${PLATFORM_DOMAIN:-}" ]; then
  err "USER_ID or PLATFORM_DOMAIN not set in /etc/workspace.env"
  exit 1
fi

readonly TARGET_USER="${TARGET_USER:-ubuntu}"
readonly TARGET_HOME="/home/${TARGET_USER}"
readonly PROJECT_DIR="${TARGET_HOME}/AI-IDE"
readonly PROXY_SCHEME="${PLATFORM_PROTOCOL:-http}"
readonly ONLYOFFICE_DIR=/opt/onlyoffice

as_user() {
  runuser -u "$TARGET_USER" -- "$@"
}

# ─────────────────────────────────────────────────────────────────────
# Step 1 — git pull the backend + frontend so we ship the tip of main
#          even when the AMI is older than HEAD.
# ─────────────────────────────────────────────────────────────────────

hdr "Step 1 — git pull repos"

pull_and_install() {
  local name="$1" dir="$2"
  if [ ! -d "$dir/.git" ]; then
    warn "${name}: ${dir} is not a git checkout — AMI bake is broken; skipping"
    return 0
  fi

  log "${name}: fetching tip of remote default branch"
  local lock_before lock_after sha_before sha_after
  lock_before=$(sha256sum "$dir/package-lock.json" 2>/dev/null | awk '{print $1}')
  sha_before=$(as_user git -C "$dir" rev-parse HEAD 2>/dev/null || echo unknown)

  # `fetch origin HEAD` explicitly grabs the remote's default-branch tip
  # and writes it to FETCH_HEAD. That's branch-name- and
  # symbolic-ref-agnostic: it doesn't depend on the local
  # `origin/HEAD` ref (which is set at clone time and can drift if a
  # bake-from-bake clones a different branch). `--force` lets the
  # fetch overwrite a shallow ref that already points at the same name.
  if ! as_user git -C "$dir" fetch --depth=1 --force origin HEAD 2>&1 | sed 's/^/    /'; then
    err "${name}: git fetch failed — aborting"
    return 1
  fi
  as_user git -C "$dir" reset --hard FETCH_HEAD 2>&1 | sed 's/^/    /'

  sha_after=$(as_user git -C "$dir" rev-parse HEAD 2>/dev/null || echo unknown)
  lock_after=$(sha256sum "$dir/package-lock.json" 2>/dev/null | awk '{print $1}')

  if [ "$sha_before" = "$sha_after" ]; then
    log "${name}: already at ${sha_after:0:7} (no remote changes)"
  else
    log "${name}: ${sha_before:0:7} → ${sha_after:0:7}"
  fi

  if [ "$lock_before" != "$lock_after" ]; then
    log "${name}: package-lock.json changed — running npm install"
    as_user bash -lc "cd '$dir' && npm install --no-fund --no-audit --registry=https://registry.npmjs.org" 2>&1 | sed 's/^/    /'
  else
    log "${name}: package-lock.json unchanged — skipping npm install"
  fi
}

pull_and_install backend  "${PROJECT_DIR}/backend"
pull_and_install frontend "${PROJECT_DIR}/frontend"

ok "Repos up to date"

# ─────────────────────────────────────────────────────────────────────
# Step 2 — Reset ONLYOFFICE volumes so the new JWT secret takes effect.
# The baked AMI's postgres state is encrypted with the source workspace's
# OFFICE_JWT_SECRET; running with a fresh secret against the old state
# breaks document open / save. Wiping the data dirs forces ONLYOFFICE
# to recreate them cleanly under the new secret.
# ─────────────────────────────────────────────────────────────────────

hdr "Step 2 — Reset ONLYOFFICE state for new JWT secret"

if [ -z "${OFFICE_JWT_SECRET:-}" ]; then
  err "OFFICE_JWT_SECRET missing from /etc/workspace.env"
  exit 1
fi

log "Stopping ONLYOFFICE compose stack"
systemctl stop ai-ide-onlyoffice.service 2>&1 | sed 's/^/    /' || true
( cd "$ONLYOFFICE_DIR" && /usr/bin/docker compose down 2>&1 | sed 's/^/    /' ) || true

log "Wiping baked-in data + db volumes"
for sub in docs sheets; do
  for vol in data db lib logs; do
    rm -rf "${ONLYOFFICE_DIR:?}/${sub}/${vol}"
    mkdir -p "${ONLYOFFICE_DIR}/${sub}/${vol}"
  done
done

log "Rewriting ${ONLYOFFICE_DIR}/.env with this instance's JWT secret"
cat > "${ONLYOFFICE_DIR}/.env" <<EOF
OFFICE_JWT_SECRET=${OFFICE_JWT_SECRET}
EOF
chmod 600 "${ONLYOFFICE_DIR}/.env"

log "Bringing ONLYOFFICE back up under the new secret"
systemctl start ai-ide-onlyoffice.service 2>&1 | sed 's/^/    /'
ok "ONLYOFFICE reset complete"

# ─────────────────────────────────────────────────────────────────────
# Step 3 — Per-user ~/.claude/CLAUDE.md
# Embeds the user's URLs so direct `claude` CLI invocations (terminal,
# code-server, etc.) get the right proxy-environment context.
# ─────────────────────────────────────────────────────────────────────

hdr "Step 3 — Write ~/.claude/CLAUDE.md"

as_user mkdir -p "${TARGET_HOME}/.claude/skills"

cat > "${TARGET_HOME}/.claude/CLAUDE.md" <<MDEOF
# Workspace environment

This workspace runs behind an edge proxy + per-user Traefik. HTTP services
exposed here are reachable from the user's browser ONLY through a public
subdomain — \`http://localhost:<port>\` URLs are NOT reachable from the
browser (it's on a different origin).

## Default service URLs

- Frontend (Next.js, port 3000):  ${PROXY_SCHEME}://frontend-${USER_ID}.${PLATFORM_DOMAIN}
- Backend API (Hono, port 8090):  ${PROXY_SCHEME}://api-${USER_ID}.${PLATFORM_DOMAIN}
- code-server / IDE (port 8080):  ${PROXY_SCHEME}://ide-${USER_ID}.${PLATFORM_DOMAIN}

## Pre-installed office editors

ONLYOFFICE Docs Server is installed by default on every workspace:

- **docs**   (DOCX, port 4000): ${PROXY_SCHEME}://docs-${USER_ID}.${PLATFORM_DOMAIN}
- **sheets** (XLSX, port 4001): ${PROXY_SCHEME}://sheets-${USER_ID}.${PLATFORM_DOMAIN}

Don't send the user to those raw URLs — they serve ONLYOFFICE's own
welcome page, not the user's document. To open a real document, use the
backend's \`/api/office/config\` endpoint to get a signed editor config,
then mount \`new DocsAPI.DocEditor(...)\` inside the frontend. The
companion Playwright-driven sidecars \`docs-agent\` and \`sheets-agent\`
host headless co-editor sessions and bridge MCP tool calls into the
editor's JS API.

When the user asks to edit a document or spreadsheet, prefer the
\`docs_*\` / \`sheets_*\` MCP tools (when available) over UI automation.

## Adding a new service

When you start a new HTTP service in this workspace:

1. Bind it to localhost or 0.0.0.0 on any unprivileged port.
2. Register the port — either via the MCP tool \`register_service\` if
   you're in chat, or directly:
   \`\`\`bash
   curl -X POST -H 'Content-Type: application/json' \\
     -d '{"port": <PORT>}' \\
     "\${PROXY_ROUTER_URL}/api/services/\${USER_ID}"
   \`\`\`
3. Use the returned URL — NOT \`http://localhost:<port>\` — anywhere the
   browser needs to reach the service.

Without step 2, browser fetches will fail with DNS / CORS errors.

## Subdomain convention

A registered port \`P\` (no custom name) becomes:
  \`${PROXY_SCHEME}://port-P-${USER_ID}.${PLATFORM_DOMAIN}\`

## CORS

The browser's origin is \`${PROXY_SCHEME}://frontend-${USER_ID}.${PLATFORM_DOMAIN}\`.
Backends must allow that origin (or \`*\`) on cross-origin XHR. The default
backend already does.

## Don't

- Don't hardcode \`localhost\` / \`127.0.0.1\` URLs in browser-facing code.
- Don't bind privileged ports (<1024). Port 80 is Traefik's.
- Don't print \`http://localhost:<port>\` as the dev URL — the user will
  copy it and get a broken page. Print the registered public URL instead.

# Chat output: links

Links you write in chat replies render as inline pill-buttons that open
the URL as a workspace tab (not plain \`<a>\` tags). So:

- Always write a URL as a markdown link with a short descriptive label:
  \`[Open the dashboard](http://frontend-...)\`. Never paste raw URLs.
- Don't say "navigate to ..." or "open ... in your browser". Just give
  the link button — one click does it.
- Code-formatted URLs (\`http://...\`) stay as code; only markdown links
  become buttons. Use code for URLs the user copies, link syntax for
  URLs they should open.

# Iframe compatibility

Every service exposed through the workspace is rendered inside an iframe
in the user's AI-IDE UI. Anything you build MUST be embeddable or the
user sees a blank tab.

## Rule: don't block framing

- Don't set \`X-Frame-Options: DENY\` or \`SAMEORIGIN\`. If a framework
  sets it by default (Helmet, Spring Security, Django middleware, older
  Next.js), remove or override it.
- Don't set a CSP with \`frame-ancestors 'none'\` or \`frame-ancestors
  'self'\`. Either omit \`frame-ancestors\` or use \`frame-ancestors *\`
  (or the frontend origin specifically).
- Don't write \"frame-buster\" JS like
  \`if (window.top !== window.self) window.top.location = …\`.

## Rule: cookies must work cross-origin

The iframe URL is a different origin from the parent frontend, so any
cookie the iframe relies on must be:

- \`SameSite=None; Secure\` — required for cookies sent in a third-party
  context. Plain \`SameSite=Lax\` cookies silently get dropped.
- HTTPS-only once TLS is on. \`Secure\` is mandatory with \`SameSite=None\`.

## Rule: auth flows can't full-page-redirect

OAuth/SSO providers that redirect via \`top.location\` (or refuse to load
in an iframe) break inside the workspace. When scaffolding auth, prefer:

1. Backend-handled OAuth — provider redirects to your backend, which sets
   the cookie and 302s to your app, all in the iframe.
2. Popup-based auth — open a new window for the redirect, post the token
   back to the iframe via \`postMessage\`.

Warn the user explicitly if a chosen auth provider refuses iframe
embedding (Google's OAuth screen does, Auth0's does too by default).

# E2E testing with Playwright (Docker)

This workspace has a long-running Docker container named
\`ai-ide-playwright\` with Playwright + Chromium + Firefox + WebKit
pre-installed. Use it for end-to-end tests and browser automation.

## When to run E2E tests — project completion rule (DEFAULT, not opt-in)

**After you finish a user-visible change to a project** — built a new
page, added a form, wired up auth, fixed a UI bug, anything the user
would interact with in a browser — you MUST run a Playwright E2E test
against what you built BEFORE telling the user "done".

**Do this even when the user did NOT ask for tests.** E2E verification
on completion is the default behavior of this workspace.

Skip only when: pure backend work with no UI, doc/config tweaks,
one-shot scripts, user explicitly says "don't test", or the feature
can't be tested headlessly.

## How to run

Always exec inside the container (the host may not have browsers / OS deps):

\`\`\`bash
docker exec -w /work/<subfolder> ai-ide-playwright \\
  npm init playwright@latest -- --quiet --browser=chromium --lang=ts
docker exec -w /work/<subfolder> ai-ide-playwright npx playwright test
\`\`\`

Reach host services via \`host.docker.internal\` instead of \`localhost\`.
For services exposed through the workspace proxy, use the public proxy
URL instead — it works from inside the container too.

If \`docker exec ai-ide-playwright …\` errors with "no such container",
bring it back up:
\`docker compose -f ${PROJECT_DIR}/playwright/docker-compose.yml up -d\`

# Environment packs (installed skills)

This workspace has user-installed environment packs at \`~/.claude/skills/\`.
Each pack's \`SKILL.md\` documents tool / library / config choices the user
previously settled on. Packs are advisory **defaults** for cases where the
user hasn't specified — they do not override an explicit user instruction.

## Rule: when YOU are choosing, consult packs first

When the user's request is open-ended about tools — e.g. "give me a
database viewer" — and you would otherwise pick something on your own:

1. List \`~/.claude/skills/\` and read every relevant SKILL.md.
2. If a pack covers it, follow that pack verbatim.

If you think the pack's choice is wrong, tell the user before deviating:

> The <pack-name> pack specifies <X>, but I'd like to use <Y> here
> because <reason>. OK to deviate from the pack?

Then wait for their answer.

## Rule: when the USER chooses, defer to the user (no pushback)

If the user explicitly asks for a specific tool/library — e.g. "install
pgweb" — just do it. Don't say "the pack specifies X instead". The user
knows. This is often how they evolve their packs: try something off-pack,
decide it works, bake it into the next pack revision.

You may mention the conflict once, briefly, AFTER completing the task —
e.g. "Installed pgweb. Heads-up: the <pack> pack has Mathesar as the
default DB viewer; let me know if you'd like to update the pack."

## Rule: cross-session memory

When YOU are picking (not the user), packs are project-level decisions.
A new session asking "give me a database viewer" should still produce
whatever the pack says — re-list the packs.
MDEOF
chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.claude/CLAUDE.md"
ok "CLAUDE.md written with this instance's URLs"

# ─────────────────────────────────────────────────────────────────────
# Step 3b — Join the user's Headscale mesh (replaces the reverse-SSH tunnel)
# ─────────────────────────────────────────────────────────────────────
# Mint a per-user ephemeral auth key from the landing page, register this box
# on the tailnet, and point the backend's PLAYWRIGHT_MCP_URL at the desktop's
# MagicDNS name. Must run BEFORE Step 4 so ai-ide-backend picks up the new URL
# from /etc/workspace.env on restart. A failure here is non-fatal — the
# workspace still comes up; the Playwright/desktop integration just stays dark
# until it's retried.

hdr "Step 3b — Join Headscale mesh"

# NODE must match sanitizeNode() in src/lib/headscale.ts: lowercase, [a-z0-9-]
# only, capped at 63 chars.
NODE="$(printf '%s' "$USER_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' | cut -c1-63)"

if [ -z "${PLATFORM_API_URL:-}" ] || [ -z "${WORKSPACE_PROVISION_SECRET:-}" ]; then
  warn "PLATFORM_API_URL or WORKSPACE_PROVISION_SECRET unset — skipping mesh join"
elif [ -z "$NODE" ]; then
  warn "USER_ID did not sanitize to a usable node name — skipping mesh join"
else
  log "Requesting mesh auth key from ${PLATFORM_API_URL}"
  MESH_JSON="$(curl -fsS -X POST "${PLATFORM_API_URL}/api/workspace/mesh-authkey" \
    -H 'Content-Type: application/json' \
    -d "{\"userId\":\"${USER_ID}\",\"provisionSecret\":\"${WORKSPACE_PROVISION_SECRET}\"}" \
    2>&1)" && MESH_OK=1 || MESH_OK=0

  if [ "$MESH_OK" != "1" ]; then
    warn "mesh-authkey request failed: ${MESH_JSON}"
  else
    LOGIN_SERVER="$(printf '%s' "$MESH_JSON" | jq -r '.loginServer // empty')"
    AUTH_KEY="$(printf '%s' "$MESH_JSON" | jq -r '.authKey // empty')"
    MAGIC="$(printf '%s' "$MESH_JSON" | jq -r '.magicDnsSuffix // empty')"

    if [ -z "$LOGIN_SERVER" ] || [ -z "$AUTH_KEY" ] || [ -z "$MAGIC" ]; then
      warn "mesh-authkey response missing fields: ${MESH_JSON}"
    else
      # Guarantee a fresh machine identity for THIS instance. The AMI is baked
      # with tailscaled enabled but no state; scrub defensively in case a future
      # AMI ever bakes one, so instances never share a node key on the tailnet.
      systemctl stop tailscaled 2>/dev/null || true
      rm -f /var/lib/tailscale/tailscaled.state
      systemctl start tailscaled 2>/dev/null || true
      sleep 2

      log "tailscale up -> ${LOGIN_SERVER} as workspace-${NODE}"
      if tailscale up \
        --login-server="$LOGIN_SERVER" \
        --authkey="$AUTH_KEY" \
        --hostname="workspace-${NODE}" \
        --accept-dns=true \
        --reset 2>&1 | sed 's/^/    /'; then

        # Point the backend at the desktop's MCP over MagicDNS. Rewrite any
        # prior line so re-runs stay idempotent, then restart picks it up.
        MCP_URL="http://desktop-${NODE}.${MAGIC}:9090/"
        sed -i '/^PLAYWRIGHT_MCP_URL=/d' /etc/workspace.env
        echo "PLAYWRIGHT_MCP_URL=${MCP_URL}" >> /etc/workspace.env
        ok "Mesh joined — PLAYWRIGHT_MCP_URL=${MCP_URL}"
      else
        warn "tailscale up failed — leaving PLAYWRIGHT_MCP_URL unset"
      fi
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────
# Step 4 — Kick services so they pick up the new /etc/workspace.env
# ─────────────────────────────────────────────────────────────────────

hdr "Step 4 — Restart services to pick up the new identity"

systemctl daemon-reload
for svc in \
  ai-ide-backend \
  ai-ide-frontend \
  ai-ide-docs-agent \
  ai-ide-sheets-agent \
  ai-ide-watchdog \
  "code-server@${TARGET_USER}"; do
  log "Restarting ${svc}"
  systemctl restart "$svc" 2>&1 | sed 's/^/    /' || warn "${svc}: restart returned non-zero"
done

# Refresh the service-manager snapshot so the next apt run captures
# *this* instance's running set instead of the AMI source's.
log "Refreshing service-manager snapshot"
/usr/local/bin/service-manager.sh save 2>&1 | sed 's/^/    /' || warn "service-manager save returned non-zero"

ok "All per-instance services restarted"

# ─────────────────────────────────────────────────────────────────────
# Final summary
# ─────────────────────────────────────────────────────────────────────

hdr "Provisioning complete"

PUBLIC_IP="${PUBLIC_IP:-<EC2_PUBLIC_IP>}"

cat <<EOF

  ${BOLD}${GREEN}✓ AI-IDE Studio is up on this EC2 instance.${NC}

  ${BOLD}Public endpoints${NC} (via edge proxy + per-user Traefik on :80):
    ${GREEN}•${NC} Frontend:    ${CYAN}${PROXY_SCHEME}://frontend-${USER_ID}.${PLATFORM_DOMAIN}/${NC}
    ${GREEN}•${NC} Backend API: ${CYAN}${PROXY_SCHEME}://api-${USER_ID}.${PLATFORM_DOMAIN}/${NC}
    ${GREEN}•${NC} code-server: ${CYAN}${PROXY_SCHEME}://ide-${USER_ID}.${PLATFORM_DOMAIN}/${NC}
    ${GREEN}•${NC} docs:        ${CYAN}${PROXY_SCHEME}://docs-${USER_ID}.${PLATFORM_DOMAIN}/${NC}
    ${GREEN}•${NC} sheets:      ${CYAN}${PROXY_SCHEME}://sheets-${USER_ID}.${PLATFORM_DOMAIN}/${NC}

  ${BOLD}Direct EC2 IP:${NC} ${CYAN}${PUBLIC_IP}${NC}
  ${BOLD}AMI version:${NC}  ${CYAN}$(cat /etc/ai-ide-ami-version)${NC}
  ${BOLD}Provision log:${NC} ${CYAN}${LOG_FILE}${NC}

EOF
