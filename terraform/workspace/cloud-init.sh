#!/usr/bin/env bash
#
# AI-IDE Studio — EC2 cloud-init startup script
#
# This script is designed to run as **root** on a fresh Ubuntu 22.04/24.04
# EC2 instance via cloud-init (user-data). It's fully non-interactive —
# no prompts, no `read` calls, no human input required.
#
# What it does:
#   1. apt base packages + Node.js 20 LTS + Claude Code CLI + code-server
#   2. Clones backend (AIWorkspaceBackEnd) + frontend (AIWorkspaceFrontEnd)
#      into /home/ubuntu/AI-IDE/{backend,frontend}
#   3. npm install in both projects (as the ubuntu user)
#   4. Configures code-server to bind 0.0.0.0:8080 with auth disabled
#   5. Creates systemd services for backend + frontend + code-server so
#      everything auto-starts on boot
#   6. Installs Docker Engine + runs a Playwright (+ Chromium) container
#      named 'ai-ide-playwright' for tests / AI-driven browser automation
#
# Usage (paste into EC2 user-data field at instance launch):
#   #!/bin/bash
#   curl -fsSL https://raw.githubusercontent.com/techLover1122/-AIWorkspaceBackEnd/main/scripts/cloud-init.sh | bash
#
# Or upload directly as the user-data script.
#
# Required EC2 Security Group inbound rules (TCP):
#   - 22    (SSH)
#   - 80    (frontend — Next.js bound to privileged port via systemd
#            AmbientCapabilities; no nginx needed)
#   - 8080  (code-server — VS Code in browser)
#   - 8090  (backend — called directly by the browser, since the frontend
#            exposes the backend URL via NEXT_PUBLIC_BACKEND_URL)
#
# ⚠ SECURITY WARNING
#   code-server is configured WITHOUT authentication and bound to 0.0.0.0.
#   Anyone who can reach the EC2 public IP on port 8080 has a root shell
#   inside the VS Code terminal. RESTRICT THE SECURITY GROUP to your own
#   IP, or enable auth in /home/ubuntu/.config/code-server/config.yaml
#   before exposing this machine to the internet.
#
# Logs land in /var/log/ai-ide-install.log — `tail -f` it to watch progress.

set -euo pipefail

# cloud-init invokes user-data with a minimal env — $HOME is unset even when
# running as root. The official code-server installer (and a couple of npm
# subcommands) read $HOME and die under `set -u`, so pin it explicitly.
export HOME="${HOME:-/root}"

# Pull IMDS-derived identity + AWS creds from the shared env file written by
# user-data.sh.tftpl. Using `set -a` so every var becomes exported, then
# turning it back off to avoid polluting the rest of the script's behavior.
if [ -f /etc/workspace.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/workspace.env
  set +a
fi

# ────────────────────────────────────────────────────────────────────
# Constants
# ────────────────────────────────────────────────────────────────────

readonly REPO_BACKEND="https://github.com/techLover1122/-AIWorkspaceBackEnd.git"
readonly REPO_FRONTEND="https://github.com/techLover1122/AIWorkspaceFrontEnd.git"
readonly TARGET_USER="${TARGET_USER:-ubuntu}"
readonly TARGET_HOME="/home/${TARGET_USER}"
readonly PROJECT_DIR="${TARGET_HOME}/AI-IDE"
readonly NODE_MAJOR=20
readonly BACKEND_PORT=8090
# Traefik (installed by user-data.sh.tftpl) owns :80 and proxies
# frontend.$USER_ID.$PLATFORM_DOMAIN → 127.0.0.1:$FRONTEND_PORT, so the
# Next.js process must NOT bind a privileged port anymore.
readonly FRONTEND_PORT=3000
readonly CODE_SERVER_PORT=8080
readonly LOG_FILE="/var/log/ai-ide-install.log"

# ────────────────────────────────────────────────────────────────────
# Logging — tee everything to both console and log file, with colors
# ────────────────────────────────────────────────────────────────────

mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

# Color codes (work in cloud-init output, `tail -f`, journalctl, and most
# terminals). If TERM is "dumb" or we're not on a tty, the escapes still
# render fine when viewed with `less -R` or `cat`.
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
CYAN=$'\033[0;36m'
MAGENTA=$'\033[0;35m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
NC=$'\033[0m'

ts()    { date '+%H:%M:%S'; }
log()   { echo "${BLUE}▸${NC} ${DIM}[$(ts)]${NC} $*"; }
ok()    { echo "${GREEN}✓${NC} ${DIM}[$(ts)]${NC} ${GREEN}$*${NC}"; }
warn()  { echo "${YELLOW}!${NC} ${DIM}[$(ts)]${NC} ${YELLOW}$*${NC}"; }
err()   { echo "${RED}✗${NC} ${DIM}[$(ts)]${NC} ${RED}$*${NC}" >&2; }
skip()  { echo "${YELLOW}~${NC} ${DIM}[$(ts)]${NC} $* ${DIM}(skipped — already present)${NC}"; }
hdr()   { echo; echo "${BOLD}${CYAN}═══════════════════════════════════════════════${NC}"; \
          echo "${BOLD}${CYAN}  $*${NC}"; \
          echo "${BOLD}${CYAN}═══════════════════════════════════════════════${NC}"; }
done_step() { echo "${BOLD}${GREEN}── ✓ Step complete — $* ──${NC}"; echo; }

# Pipe output of slow commands through this to indent + dim, so users
# watching `tail -f` can see progress without it overwhelming the log.
indent() { sed "s/^/    ${DIM}│${NC} /"; }

# ────────────────────────────────────────────────────────────────────
# Pre-flight — must be root + Ubuntu
# ────────────────────────────────────────────────────────────────────

hdr "Pre-flight"
log "AI-IDE EC2 cloud-init script — $(date)"

if [ "$(id -u)" != "0" ]; then
  log "ERROR: this script must run as root (cloud-init context)."
  log "       If running manually, prefix with sudo."
  exit 1
fi

if ! [ -f /etc/os-release ]; then
  log "ERROR: can't read /etc/os-release — not Linux?"
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  log "ERROR: this script targets Ubuntu. Detected: ${PRETTY_NAME:-unknown}"
  exit 1
fi

if ! id "$TARGET_USER" >/dev/null 2>&1; then
  log "ERROR: target user '$TARGET_USER' doesn't exist."
  log "       The standard Ubuntu EC2 AMI provides 'ubuntu' by default."
  exit 1
fi

log "OS: $PRETTY_NAME"
log "Target user: $TARGET_USER ($TARGET_HOME)"
log "Project will be cloned to: $PROJECT_DIR"

# Helper — run a command as the target user
as_user() {
  runuser -u "$TARGET_USER" -- "$@"
}

# ────────────────────────────────────────────────────────────────────
# Step 0 — Swap (t3.micro has 1 GB RAM; npm install OOMs without it)
# ────────────────────────────────────────────────────────────────────

hdr "Step 0 — Swap (avoids OOM during npm install on small instances)"

if swapon --show | grep -q .; then
  skip "swap already active"
else
  log "Creating 2 GB /swapfile"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile 2>&1 | indent
  swapon /swapfile
  # Persist across reboots.
  if ! grep -q '^/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  ok "2 GB swap activated and persisted in /etc/fstab"
fi
free -h | indent
done_step "Step 0 — Swap"

# ────────────────────────────────────────────────────────────────────
# Step 1 / 8 — apt base packages
# ────────────────────────────────────────────────────────────────────

hdr "Step 1 / 8 — apt base packages"

export DEBIAN_FRONTEND=noninteractive

log "Refreshing apt package index"
apt-get update 2>&1 | indent

log "Installing: curl, ca-certificates, gnupg, git, build-essential, python3, unzip"
apt-get install -y \
  curl ca-certificates gnupg git \
  build-essential python3 unzip 2>&1 | indent

ok "Base packages installed"
done_step "Step 1 / 8 — apt base packages"

# ────────────────────────────────────────────────────────────────────
# Step 2 / 8 — Node.js 20 LTS
# ────────────────────────────────────────────────────────────────────

hdr "Step 2 / 8 — Node.js ${NODE_MAJOR} LTS"

if command -v node >/dev/null && [ "$(node -v | sed -E 's/^v([0-9]+)\..*/\1/')" -ge "$NODE_MAJOR" ]; then
  skip "node $(node -v) already installed"
else
  log "Adding NodeSource APT repo for Node ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - 2>&1 | indent
  log "Installing nodejs package"
  apt-get install -y nodejs 2>&1 | indent
fi

ok "node $(node -v) / npm $(npm -v) ready"
done_step "Step 2 / 8 — Node.js"

# ────────────────────────────────────────────────────────────────────
# Step 3 / 8 — Claude Code CLI
# ────────────────────────────────────────────────────────────────────

hdr "Step 3 / 8 — Claude Code CLI"

if command -v claude >/dev/null; then
  skip "claude already installed"
else
  log "Downloading @anthropic-ai/claude-code from npm (this can take ~30s)"
  npm install -g @anthropic-ai/claude-code 2>&1 | indent
fi

ok "claude $(claude --version 2>/dev/null | head -1 || echo unknown)"
done_step "Step 3 / 8 — Claude Code CLI"

# ────────────────────────────────────────────────────────────────────
# Step 4 / 8 — code-server
# ────────────────────────────────────────────────────────────────────

hdr "Step 4 / 8 — code-server (VS Code in browser)"

if command -v code-server >/dev/null; then
  skip "code-server already installed"
else
  log "Downloading + installing code-server (official install script)"
  curl -fsSL https://code-server.dev/install.sh | sh 2>&1 | indent
fi

log "Writing code-server config (bind 0.0.0.0:${CODE_SERVER_PORT}, auth=none)"
as_user mkdir -p "${TARGET_HOME}/.config/code-server"
cat > "${TARGET_HOME}/.config/code-server/config.yaml" <<EOF
bind-addr: 0.0.0.0:${CODE_SERVER_PORT}
auth: none
cert: false
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.config"

# ---- User-level VS Code settings ----
# Hide the things the user doesn't want polluting the workspace when they
# open code-server for the first time:
#   - workbench.startupEditor=none        → no Welcome / "Get Started" tab
#   - window.menuBarVisibility=hidden     → hides the top File/Edit/View menu bar
#   - workbench.layoutControl.enabled=false → hides layout-control buttons in title
#   - chat.commandCenter.enabled=false    → hides AI chat in title bar
# Secondary side bar (the right-side panel where Copilot / Cline / Continue
# put their chat) is closed by default — once the user closes it manually it
# stays closed across sessions. There's no global setting to force-hide it.
log "Writing code-server user settings.json (hide welcome / menu bar / chat panel)"
readonly CODE_USER_DIR="${TARGET_HOME}/.local/share/code-server/User"
as_user mkdir -p "$CODE_USER_DIR"
cat > "${CODE_USER_DIR}/settings.json" <<'EOF'
{
  "workbench.startupEditor": "none",
  "window.menuBarVisibility": "hidden",
  "workbench.layoutControl.enabled": false,
  "chat.commandCenter.enabled": false,
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "update.showReleaseNotes": false,
  "extensions.autoCheckUpdates": false,
  "security.workspace.trust.enabled": false
}
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.local/share/code-server"

ok "code-server $(code-server --version 2>/dev/null | head -1) ready"
done_step "Step 4 / 8 — code-server"

# ────────────────────────────────────────────────────────────────────
# Step 5 / 8 — Clone repos
# ────────────────────────────────────────────────────────────────────

hdr "Step 5 / 8 — Clone backend + frontend repos"

as_user mkdir -p "$PROJECT_DIR"

clone_or_pull() {
  local repo_url="$1" target_dir="$2" name="$3"
  if [ -d "${target_dir}/.git" ]; then
    log "${name}: existing checkout found — git pull --ff-only"
    as_user git -C "$target_dir" pull --ff-only 2>&1 | indent
  else
    log "${name}: cloning from ${repo_url}"
    as_user git clone --depth=1 "$repo_url" "$target_dir" 2>&1 | indent
  fi
}

clone_or_pull "$REPO_BACKEND"  "${PROJECT_DIR}/backend"  "backend"
clone_or_pull "$REPO_FRONTEND" "${PROJECT_DIR}/frontend" "frontend"

ok "Both repos checked out under ${PROJECT_DIR}"
done_step "Step 5 / 8 — Clone repos"

# ────────────────────────────────────────────────────────────────────
# Step 6 / 8 — npm install (frontend + backend)
# ────────────────────────────────────────────────────────────────────

hdr "Step 6 / 8 — npm install (this can take 2-5 minutes)"

# Both repos pin the China npm mirror (registry.npmmirror.com) in their
# .npmrc and in lockfile `resolved` URLs. That mirror returns 503 constantly
# from us-west-2, so swap every reference to the official registry before
# installing. --registry on the install command alone is not enough — npm
# uses the URLs already baked into package-lock.json.
for d in "${PROJECT_DIR}/backend" "${PROJECT_DIR}/frontend"; do
  for f in "$d/.npmrc" "$d/package-lock.json"; do
    [ -f "$f" ] || continue
    log "Rewriting npmmirror.com -> npmjs.org in $f"
    as_user sed -i 's|registry\.npmmirror\.com|registry.npmjs.org|g' "$f"
  done
done

NPM_FLAGS="--no-fund --no-audit --registry=https://registry.npmjs.org"

log "backend: npm install (downloading packages...)"
as_user bash -lc "cd ${PROJECT_DIR}/backend && npm install $NPM_FLAGS" 2>&1 | indent
ok "backend dependencies installed"

log "frontend: npm install (downloading packages...)"
as_user bash -lc "cd ${PROJECT_DIR}/frontend && npm install $NPM_FLAGS" 2>&1 | indent
ok "frontend dependencies installed"

done_step "Step 6 / 8 — npm install"

# ────────────────────────────────────────────────────────────────────
# Step 7 / 8 — systemd services
# ────────────────────────────────────────────────────────────────────

hdr "Step 7 / 8 — systemd services (backend + frontend + code-server)"

# --- Backend service ---
# Pulls INSTANCE_ID / INSTANCE_IP / INSTANCE_URL / BUCKET_ID / AWS_REGION /
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from /etc/workspace.env (written by
# the wrapper user-data). Environment= overrides PORT so the backend listens
# on its own port, not the workspace server's.
cat > /etc/systemd/system/ai-ide-backend.service <<EOF
[Unit]
Description=AI-IDE Backend (Hono API on :${BACKEND_PORT})
After=network.target

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${PROJECT_DIR}/backend
EnvironmentFile=/etc/workspace.env
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=${BACKEND_PORT}
ExecStart=/usr/bin/npm run dev
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# --- Frontend service ---
# Frontend listens on $FRONTEND_PORT (unprivileged). The browser hits it via
# Traefik at http://frontend-$USER_ID.$PLATFORM_DOMAIN/, and Traefik proxies
# to 127.0.0.1:$FRONTEND_PORT. NEXT_PUBLIC_* URLs are public hosts so the
# browser also routes through Traefik (backend → api-..., code-server → ide-...).
# The dash-separator keeps every subdomain one DNS label deep so a single
# *.platform.bytescripterz.com wildcard CNAME covers every user.
#
# NOTE on ExecStart: the upstream frontend's `npm run dev` script hard-codes
# `next dev -p 80`, which overrides any PORT env var and (since we run as
# the unprivileged ubuntu user without AmbientCapabilities) fails with
# EACCES. Bypass the npm script by calling next's binary directly.
cat > /etc/systemd/system/ai-ide-frontend.service <<EOF
[Unit]
Description=AI-IDE Frontend (Next.js on :${FRONTEND_PORT})
After=network.target ai-ide-backend.service

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${PROJECT_DIR}/frontend
# Inherit shared instance metadata + IAM creds from the wrapper user-data.
EnvironmentFile=/etc/workspace.env
Environment=NEXT_PUBLIC_BACKEND_URL=${PLATFORM_PROTOCOL:-http}://api-${USER_ID}.${PLATFORM_DOMAIN}
Environment=NEXT_PUBLIC_CODE_SERVER_URL=${PLATFORM_PROTOCOL:-http}://ide-${USER_ID}.${PLATFORM_DOMAIN}
# Frontend uses these to detect platform-internal URLs in chat-link
# buttons and ensure the corresponding service is registered before
# the user's browser tries to load them.
Environment=NEXT_PUBLIC_USER_ID=${USER_ID}
Environment=NEXT_PUBLIC_PLATFORM_DOMAIN=${PLATFORM_DOMAIN}
ExecStart=${PROJECT_DIR}/frontend/node_modules/.bin/next dev -p ${FRONTEND_PORT} -H 0.0.0.0
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Reload + enable + start
systemctl daemon-reload

# code-server ships its own unit at code-server@.service — drop in an
# override so it starts with the project directory open by default. That
# way the user lands directly in /home/<user>/AI-IDE instead of seeing
# the "Open Folder" placeholder.
log "Configuring code-server to open ${PROJECT_DIR} by default"
mkdir -p "/etc/systemd/system/code-server@${TARGET_USER}.service.d"
cat > "/etc/systemd/system/code-server@${TARGET_USER}.service.d/override.conf" <<EOF
[Service]
# Clear the default ExecStart so we don't end up with two of them.
ExecStart=
ExecStart=/usr/bin/code-server ${PROJECT_DIR}
EOF
systemctl daemon-reload

log "Enabling code-server@${TARGET_USER}"
systemctl enable --now "code-server@${TARGET_USER}" || true

log "Enabling ai-ide-backend"
systemctl enable --now ai-ide-backend

log "Enabling ai-ide-frontend"
systemctl enable --now ai-ide-frontend

# Give the services a moment to start, then sanity-check
sleep 5
for svc in "code-server@${TARGET_USER}" ai-ide-backend ai-ide-frontend; do
  state=$(systemctl is-active "$svc" || true)
  if [ "$state" = "active" ]; then
    ok "  ${svc}: ${state}"
  else
    warn "  ${svc}: ${state}"
  fi
done

done_step "Step 7 / 8 — systemd services"

# ────────────────────────────────────────────────────────────────────
# Step 8 / 8 — Docker + Playwright (+ Chromium) container
# ────────────────────────────────────────────────────────────────────
#
# Installs Docker Engine via the official Docker apt repo, then runs a
# Playwright container (Chromium + Firefox + WebKit pre-installed) named
# `ai-ide-playwright`. The container stays up across reboots so the AI
# panel can drive browsers / run tests on demand.
#
# Self-contained: the docker-compose.yml is written inline so this step
# doesn't depend on cloning the AI-IDE meta-repo.

hdr "Step 8 / 8 — Docker + Playwright + Chromium container"

readonly PLAYWRIGHT_DIR="${PROJECT_DIR}/playwright"
readonly PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.49.0-jammy"
readonly PLAYWRIGHT_CONTAINER="ai-ide-playwright"

# --- 8a. Install Docker Engine if missing ---
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  skip "Docker already installed and reachable ($(docker --version))"
else
  log "Adding Docker's official APT keyring"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  log "Adding Docker APT repository for ${VERSION_CODENAME:-$(. /etc/os-release && echo "$VERSION_CODENAME")}"
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list

  log "Refreshing apt index for Docker packages"
  apt-get update 2>&1 | indent

  log "Installing: docker-ce, docker-ce-cli, containerd.io, docker-buildx-plugin, docker-compose-plugin"
  apt-get install -y \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin 2>&1 | indent

  log "Enabling docker.service"
  systemctl enable --now docker

  log "Adding ${TARGET_USER} to the 'docker' group (so it can run docker without sudo)"
  usermod -aG docker "$TARGET_USER" || true

  ok "Docker installed: $(docker --version)"
fi

# --- 8b. Write the docker-compose.yml (inline, self-contained) ---
log "Writing Playwright docker-compose.yml at ${PLAYWRIGHT_DIR}/docker-compose.yml"
as_user mkdir -p "$PLAYWRIGHT_DIR"
cat > "${PLAYWRIGHT_DIR}/docker-compose.yml" <<EOF
services:
  playwright:
    image: ${PLAYWRIGHT_IMAGE}
    container_name: ${PLAYWRIGHT_CONTAINER}
    restart: unless-stopped
    shm_size: 2gb
    volumes:
      - ${PROJECT_DIR}:/work
    working_dir: /work
    command: sleep infinity
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "$PLAYWRIGHT_DIR"
ok "docker-compose.yml written"

# --- 8c. Pull the image (large download — show progress) ---
log "Pulling ${PLAYWRIGHT_IMAGE} (~1.6 GB — first time only, this may take 2-4 min)"
log "${DIM}Each layer line below = ~MB of download progress.${NC}"
docker pull "$PLAYWRIGHT_IMAGE" 2>&1 | indent
ok "Image pulled"

# --- 8d. Start the container ---
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PLAYWRIGHT_CONTAINER"; then
  skip "Container '${PLAYWRIGHT_CONTAINER}' already running"
else
  log "Starting container '${PLAYWRIGHT_CONTAINER}'"
  docker compose -f "${PLAYWRIGHT_DIR}/docker-compose.yml" up -d 2>&1 | indent
fi

# --- 8e. Verify container is actually up and Playwright works ---
sleep 2
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PLAYWRIGHT_CONTAINER"; then
  pw_version=$(docker exec "$PLAYWRIGHT_CONTAINER" npx playwright --version 2>/dev/null || echo "unknown")
  ok "Container '${PLAYWRIGHT_CONTAINER}' is running — ${pw_version}"
  log "Try:  docker exec -it ${PLAYWRIGHT_CONTAINER} npx playwright --version"
  log "Test: docker exec -it ${PLAYWRIGHT_CONTAINER} npx playwright open https://example.com"
else
  err "Container '${PLAYWRIGHT_CONTAINER}' didn't start. Inspect with:"
  err "    docker compose -f ${PLAYWRIGHT_DIR}/docker-compose.yml logs"
fi

done_step "Step 8 / 8 — Playwright Docker container"

# ────────────────────────────────────────────────────────────────────
# Make sure .claude/skills dir exists for future skill installs
# ────────────────────────────────────────────────────────────────────

as_user mkdir -p "${TARGET_HOME}/.claude/skills"

# ────────────────────────────────────────────────────────────────────
# Drop a CLAUDE.md so direct `claude` CLI invocations (terminal, code-
# server, etc.) also get proxy-environment context — not just chat
# requests routed through the backend, which inject the same content via
# the SDK's appendSystemPrompt option.
# ────────────────────────────────────────────────────────────────────

# Source /etc/workspace.env to get USER_ID / PLATFORM_DOMAIN. user-data.sh
# already exported these for the parent shell, but cloud-init.sh runs in
# its own shell — re-source defensively.
if [ -f /etc/workspace.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/workspace.env
  set +a
fi

PROXY_DOMAIN="${PLATFORM_DOMAIN:-platform.bytescripterz.com}"
PROXY_USER="${USER_ID:-unknown}"
PROXY_SCHEME="${PLATFORM_PROTOCOL:-http}"

cat > "${TARGET_HOME}/.claude/CLAUDE.md" <<MDEOF
# Workspace environment

This workspace runs behind an edge proxy + per-user Traefik. HTTP services
exposed here are reachable from the user's browser ONLY through a public
subdomain — \`http://localhost:<port>\` URLs are NOT reachable from the
browser (it's on a different origin).

## Default service URLs

- Frontend (Next.js, port 3000):  ${PROXY_SCHEME}://frontend-${PROXY_USER}.${PROXY_DOMAIN}
- Backend API (Hono, port 8090):  ${PROXY_SCHEME}://api-${PROXY_USER}.${PROXY_DOMAIN}
- code-server / IDE (port 8080):  ${PROXY_SCHEME}://ide-${PROXY_USER}.${PROXY_DOMAIN}

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
  \`${PROXY_SCHEME}://port-P-${PROXY_USER}.${PROXY_DOMAIN}\`

## CORS

The browser's origin is \`${PROXY_SCHEME}://frontend-${PROXY_USER}.${PROXY_DOMAIN}\`.
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

# ────────────────────────────────────────────────────────────────────
# Final summary
# ────────────────────────────────────────────────────────────────────

hdr "All done — AI-IDE Studio is up"

# Public IP is exported by user-data.sh.tftpl (which already queries IMDSv2
# during bootstrap). Fall back to a placeholder only if this script is run
# manually outside that context.
PUBLIC_IP="${PUBLIC_IP:-<EC2_PUBLIC_IP>}"

cat <<EOF

  ${BOLD}${GREEN}✓ AI-IDE Studio is up on this EC2 instance.${NC}

  ${BOLD}Public endpoints${NC} (via the central edge proxy + per-user Traefik on :80):
    ${GREEN}•${NC} Frontend:    ${CYAN}${PLATFORM_PROTOCOL:-http}://frontend-${USER_ID:-<USER_ID>}.${PLATFORM_DOMAIN:-<PLATFORM_DOMAIN>}/${NC}
    ${GREEN}•${NC} Backend API: ${CYAN}${PLATFORM_PROTOCOL:-http}://api-${USER_ID:-<USER_ID>}.${PLATFORM_DOMAIN:-<PLATFORM_DOMAIN>}/${NC}
    ${GREEN}•${NC} code-server: ${CYAN}${PLATFORM_PROTOCOL:-http}://ide-${USER_ID:-<USER_ID>}.${PLATFORM_DOMAIN:-<PLATFORM_DOMAIN>}/${NC}   ${YELLOW}(NO password!)${NC}

  ${BOLD}Internal ports${NC} (bypass Traefik, useful only for SSH debugging):
    ${GREEN}•${NC} Frontend → ${CYAN}127.0.0.1:${FRONTEND_PORT}${NC}
    ${GREEN}•${NC} Backend  → ${CYAN}127.0.0.1:${BACKEND_PORT}${NC}
    ${GREEN}•${NC} code-server → ${CYAN}127.0.0.1:${CODE_SERVER_PORT}${NC}
    ${GREEN}•${NC} Direct EC2 IP: ${CYAN}${PUBLIC_IP}${NC}

  ${BOLD}Playwright + Chromium${NC} (Docker container — for tests / AI panel):
    ${GREEN}•${NC} Container:   ${CYAN}${PLAYWRIGHT_CONTAINER}${NC}
    ${GREEN}•${NC} Compose:     ${CYAN}${PLAYWRIGHT_DIR}/docker-compose.yml${NC}
    ${GREEN}•${NC} Try:         ${DIM}docker exec -it ${PLAYWRIGHT_CONTAINER} npx playwright --version${NC}
    ${GREEN}•${NC} Run a test:  ${DIM}docker exec -it ${PLAYWRIGHT_CONTAINER} npx playwright test${NC}

  ${BOLD}Service controls${NC} (run on the EC2 instance):
    ${DIM}sudo systemctl status  ai-ide-backend${NC}
    ${DIM}sudo systemctl restart ai-ide-frontend${NC}
    ${DIM}sudo journalctl -u ai-ide-backend -f${NC}
    ${DIM}sudo journalctl -u ai-ide-frontend -f${NC}
    ${DIM}sudo journalctl -u code-server@${TARGET_USER} -f${NC}
    ${DIM}docker logs -f ${PLAYWRIGHT_CONTAINER}${NC}

  ${BOLD}Install log:${NC} ${CYAN}${LOG_FILE}${NC}

  ${BOLD}${YELLOW}⚠ SECURITY WARNING${NC}
    code-server is publicly exposed on port ${CODE_SERVER_PORT} without
    authentication. Anyone reaching this IP has a root shell. Either:
      ${YELLOW}-${NC} Restrict EC2 Security Group inbound to your IP only, OR
      ${YELLOW}-${NC} Enable auth: edit ${TARGET_HOME}/.config/code-server/config.yaml
        and run ${DIM}'sudo systemctl restart code-server@${TARGET_USER}'${NC}.

  ${BOLD}Claude skills are NOT pre-installed.${NC} After SSH'ing in, either:
    ${GREEN}-${NC} Copy your skills folder to ${CYAN}${TARGET_HOME}/.claude/skills/${NC}, OR
    ${GREEN}-${NC} Tell Claude in chat: "Create a pack for <platform>" — the
      create-platform-pack meta-skill will scaffold it (if it exists).

EOF
