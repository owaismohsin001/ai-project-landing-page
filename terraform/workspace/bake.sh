#!/usr/bin/env bash
#
# AI-IDE Studio — workspace AMI bake script
#
# Run this ONCE on a fresh Ubuntu 24.04 EC2 (or on an existing workspace
# you want to re-bake) AS ROOT. It installs every piece of infrastructure
# that's identical across users — apt deps, Node, Claude CLI, code-server,
# Docker, Playwright + ONLYOFFICE images, the AI-IDE backend/frontend
# repos, and every systemd unit — so a snapshot of the result becomes
# the "workspace AMI" that the terraform module spins up for each new
# subscriber.
#
# Per-instance setup (USER_ID, AWS keys, OFFICE_JWT_SECRET, latest repo
# pulls, fresh ~/.claude/CLAUDE.md) is NOT done here — that lives in
# provision.sh which user-data.sh.tftpl fetches + runs on every new
# instance launched from the AMI.
#
# What this script DOES (rolls into the AMI):
#   1. apt base packages + Node.js 20 LTS + Claude Code CLI + code-server
#   2. Clones backend + frontend into /home/ubuntu/AI-IDE/* + npm install
#   3. Configures code-server (bind 0.0.0.0:8080, auth=none) + writes the
#      user-level settings.json (hide welcome / menu bar / etc.)
#   4. Installs systemd units that read identity from /etc/workspace.env
#      so they don't bake the source workspace's identity into the AMI
#   5. Docker Engine + the ai-ide-playwright container
#   6. ONLYOFFICE docs/sheets containers + their docs-agent / sheets-agent
#      sidecars
#   7. tmux recipe boot-restoration + service-manager snapshot hooks +
#      Traefik-aware watchdog
#
# Usage (creating the AMI):
#   sudo /opt/cloud-init/bake.sh
#   # then, off-box:
#   aws ec2 stop-instances --instance-ids <id> --profile phase1-deploy
#   aws ec2 create-image  --instance-id  <id> --name ai-workspace-YYYYMMDD …
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
# Step 1 / 9 — apt base packages
# ────────────────────────────────────────────────────────────────────

hdr "Step 1 / 9 — apt base packages"

export DEBIAN_FRONTEND=noninteractive

log "Refreshing apt package index"
apt-get update 2>&1 | indent

log "Installing: curl, ca-certificates, gnupg, git, build-essential, python3, unzip"
apt-get install -y \
  curl ca-certificates gnupg git \
  build-essential python3 unzip 2>&1 | indent

ok "Base packages installed"
done_step "Step 1 / 9 — apt base packages"

# ────────────────────────────────────────────────────────────────────
# Step 2 / 9 — Node.js 20 LTS
# ────────────────────────────────────────────────────────────────────

hdr "Step 2 / 9 — Node.js ${NODE_MAJOR} LTS"

if command -v node >/dev/null && [ "$(node -v | sed -E 's/^v([0-9]+)\..*/\1/')" -ge "$NODE_MAJOR" ]; then
  skip "node $(node -v) already installed"
else
  log "Adding NodeSource APT repo for Node ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - 2>&1 | indent
  log "Installing nodejs package"
  apt-get install -y nodejs 2>&1 | indent
fi

ok "node $(node -v) / npm $(npm -v) ready"
done_step "Step 2 / 9 — Node.js"

# ────────────────────────────────────────────────────────────────────
# Step 3 / 9 — Claude Code CLI
# ────────────────────────────────────────────────────────────────────

hdr "Step 3 / 9 — Claude Code CLI"

if command -v claude >/dev/null; then
  skip "claude already installed"
else
  log "Downloading @anthropic-ai/claude-code from npm (this can take ~30s)"
  npm install -g @anthropic-ai/claude-code 2>&1 | indent
fi

# The claude.exe wrapper does a one-time per-user binary extract on its very
# first invocation (~30s). The backend's CLI detection in
# src/utils/claudeCli.ts validates candidates with `claude --version` under a
# 5s timeout — so on a cold boot, before TARGET_USER has ever run claude, the
# wrapper's extraction blows past 5s and the backend logs
# "None of the candidate Claude CLI paths worked" → chat features stay dead
# until something warms it manually. Run once as TARGET_USER here so the cache
# at ~${TARGET_USER}/.cache/claude-cli-nodejs is populated before
# ai-ide-backend.service starts in Step 7.
log "Warming claude wrapper for ${TARGET_USER} (one-time ~30s extract)"
as_user timeout 90 /usr/bin/claude --version 2>&1 | indent \
  || warn "claude warm-up didn't finish in 90s (non-fatal; backend may log 'not detected' on first boot)"

ok "claude $(claude --version 2>/dev/null | head -1 || echo unknown)"
done_step "Step 3 / 9 — Claude Code CLI"

# ────────────────────────────────────────────────────────────────────
# Step 4 / 9 — code-server
# ────────────────────────────────────────────────────────────────────

hdr "Step 4 / 9 — code-server (VS Code in browser)"

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
  "security.workspace.trust.enabled": false,
  "window.restoreWindows": "none",
  "workbench.welcomePage.experimental.startEntries.enabled": false
}
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.local/share/code-server"

ok "code-server $(code-server --version 2>/dev/null | head -1) ready"
done_step "Step 4 / 9 — code-server"

# ────────────────────────────────────────────────────────────────────
# Step 5 / 9 — Clone repos
# ────────────────────────────────────────────────────────────────────

hdr "Step 5 / 9 — Clone backend + frontend repos"

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
done_step "Step 5 / 9 — Clone repos"

# ────────────────────────────────────────────────────────────────────
# Step 6 / 9 — npm install (frontend + backend)
# ────────────────────────────────────────────────────────────────────

hdr "Step 6 / 9 — npm install (this can take 2-5 minutes)"

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

done_step "Step 6 / 9 — npm install"

# ────────────────────────────────────────────────────────────────────
# Step 7 / 9 — systemd services
# ────────────────────────────────────────────────────────────────────

hdr "Step 7 / 9 — systemd services (backend + frontend + code-server)"

# --- Backend service ---
# Pulls INSTANCE_ID / INSTANCE_IP / INSTANCE_URL / BUCKET_ID / AWS_REGION /
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from /etc/workspace.env (written by
# the wrapper user-data). Environment= overrides PORT so the backend listens
# on its own port, not the workspace server's.
cat > /etc/systemd/system/ai-ide-backend.service <<EOF
[Unit]
Description=AI-IDE Backend (Hono API on :${BACKEND_PORT})
After=network.target
# StartLimitIntervalSec lives in [Unit] in modern systemd — putting it in
# [Service] makes systemd log "Unknown key name" and silently fall back to
# the default rate-limit (5 restarts / 10s → unit goes "failed").
StartLimitIntervalSec=0

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${PROJECT_DIR}/backend
EnvironmentFile=/etc/workspace.env
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=${BACKEND_PORT}
# ExecStart uses tsx WITHOUT --watch. Previously this was \`npm run dev\`
# which expands to \`tsx watch src/index.ts\` — a hot-reload mode. That was
# fatal here because the in-chat agent edits backend source files all the
# time (the user is BUILDING this IDE). Every Edit/Write would trip tsx's
# file watcher, restart the process, wipe the in-memory TaskRegistry, and
# drop every active stream — surfacing to the user as "Lost connection to
# the chat task" + "Failed to start chat task". Run the production entry
# point instead; if a developer wants hot reload, they stop the unit and
# run \`npm run dev\` manually in a terminal.
ExecStart=${PROJECT_DIR}/backend/node_modules/.bin/tsx src/index.ts
# Restart=always catches BOTH crashes and clean exits (signal, OOM-with-exit-0).
# The corresponding StartLimitIntervalSec=0 (disables the rate-limit) is in
# the [Unit] section above — it has no effect in [Service] in modern systemd.
# The "hung but alive" case (process up but port not answering → user sees
# 502) is caught separately by ai-ide-backend-healthcheck.timer further down.
Restart=always
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
# See ai-ide-backend.service for why this lives in [Unit] not [Service].
StartLimitIntervalSec=0

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${PROJECT_DIR}/frontend
# Identity + AWS creds + the browser-facing NEXT_PUBLIC_* URLs all come
# from /etc/workspace.env, which user-data.sh.tftpl rewrites on every
# new instance launched from this AMI. Keeping the per-user values out
# of the unit file means the unit itself can be baked into the AMI
# without leaking the source workspace's USER_ID / PLATFORM_DOMAIN.
EnvironmentFile=/etc/workspace.env
ExecStart=${PROJECT_DIR}/frontend/node_modules/.bin/next dev -p ${FRONTEND_PORT} -H 0.0.0.0
# See ai-ide-backend.service for rationale on Restart=always (no-rate-limit
# directive lives in [Unit] above). Hung dev-server detection (Next.js
# sometimes wedges with the HMR socket alive but HTTP no longer answering)
# is handled by ai-ide-frontend-healthcheck.timer.
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Reload + enable + start
systemctl daemon-reload

# code-server ships its own unit at code-server@.service — drop in an
# override so it starts with the user's home directory open by default.
# That way the Explorer shows the full filesystem (AI-IDE/, .config/,
# .claude/, ...) and the user can pick whichever subfolder they want
# instead of seeing the "Open Folder" placeholder.
log "Configuring code-server to open ${TARGET_HOME} by default"
mkdir -p "/etc/systemd/system/code-server@${TARGET_USER}.service.d"
cat > "/etc/systemd/system/code-server@${TARGET_USER}.service.d/override.conf" <<EOF
[Service]
# Clear the default ExecStart so we don't end up with two of them.
ExecStart=
ExecStart=/usr/bin/code-server ${TARGET_HOME}
EOF
systemctl daemon-reload

log "Enabling code-server@${TARGET_USER}"
systemctl enable --now "code-server@${TARGET_USER}" || true

log "Enabling ai-ide-backend"
systemctl enable --now ai-ide-backend

log "Enabling ai-ide-frontend"
systemctl enable --now ai-ide-frontend

# --- Healthcheck (watchdog) for backend + frontend ---
# Restart=always covers crashes and clean exits, but a Next/Hono dev server
# can also wedge: process stays alive, port stops answering. systemd sees
# "active" and does nothing → Traefik proxies the request, gets nothing
# back, and returns 502 to the user. This timer polls each service's local
# port every 30s and force-restarts the unit if 3 consecutive checks fail.
log "Installing healthcheck script + timers for backend + frontend"

cat > /usr/local/bin/ai-ide-healthcheck.sh <<'HEALTH_EOF'
#!/usr/bin/env bash
# ai-ide-healthcheck.sh — restart a service when its HTTP port stops answering.
# Usage: ai-ide-healthcheck.sh <service-suffix> <port>
#   e.g. ai-ide-healthcheck.sh frontend 3000
set -uo pipefail
readonly SVC_SUFFIX="${1:?need service suffix}"
readonly PORT="${2:?need port}"
readonly SVC="ai-ide-${SVC_SUFFIX}"

# Don't intervene if systemd already considers the unit down — its own
# Restart= directive is in charge there, and stacking restarts would just
# fight it.
state=$(systemctl is-active "$SVC" 2>/dev/null || true)
if [ "$state" != "active" ]; then
  echo "[ai-ide-healthcheck] ${SVC} state=${state} — leaving to systemd"
  exit 0
fi

# Three tries with a 5s timeout each — survives transient slow responses
# (Next.js compile-on-demand can spike under load on t3.small/medium)
# without restart-storming.
# IMPORTANT: NO -f flag. We only care that the TCP/HTTP stack on the port
# is responding — not that the URL returned 2xx. Backend's "/" is a 404
# (only /api/* is routed) but the process is perfectly healthy; with -f
# the healthcheck would false-restart every 30s and kill in-flight SSE.
# Without -f, curl exits 0 on any HTTP response (200/302/401/404/5xx) and
# non-zero only on connection-refused / timeout / DNS failure — exactly
# the conditions that mean "service is actually dead/hung".
for attempt in 1 2 3; do
  if curl -sS --max-time 5 -o /dev/null "http://localhost:${PORT}/" 2>/dev/null; then
    exit 0
  fi
  sleep 2
done

echo "[ai-ide-healthcheck] ${SVC} unresponsive on :${PORT} after 3 attempts — restarting"
systemctl restart "$SVC"
HEALTH_EOF
chmod 755 /usr/local/bin/ai-ide-healthcheck.sh
ok "Healthcheck script installed at /usr/local/bin/ai-ide-healthcheck.sh"

for pair in "backend:${BACKEND_PORT}" "frontend:${FRONTEND_PORT}"; do
  svc="${pair%%:*}"
  port="${pair##*:}"
  cat > "/etc/systemd/system/ai-ide-${svc}-healthcheck.service" <<EOF
[Unit]
Description=Healthcheck for ai-ide-${svc} (restart if port :${port} stops answering)
After=ai-ide-${svc}.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ai-ide-healthcheck.sh ${svc} ${port}
EOF
  cat > "/etc/systemd/system/ai-ide-${svc}-healthcheck.timer" <<EOF
[Unit]
Description=Periodic healthcheck for ai-ide-${svc}

[Timer]
# 120s boot delay so Next/Hono dev servers have time to do their first
# compile (can take 30-60s on a t3.small/medium under cold-start load).
OnBootSec=120
OnUnitActiveSec=30s
Unit=ai-ide-${svc}-healthcheck.service

[Install]
WantedBy=timers.target
EOF
done

systemctl daemon-reload
systemctl enable --now ai-ide-backend-healthcheck.timer
systemctl enable --now ai-ide-frontend-healthcheck.timer
ok "Healthcheck timers enabled (30s interval, 120s boot delay)"

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

done_step "Step 7 / 9 — systemd services"

# ────────────────────────────────────────────────────────────────────
# Step 8 / 9 — Docker + Playwright (+ Chromium) container
# ────────────────────────────────────────────────────────────────────
#
# Installs Docker Engine via the official Docker apt repo, then runs a
# Playwright container (Chromium + Firefox + WebKit pre-installed) named
# `ai-ide-playwright`. The container stays up across reboots so the AI
# panel can drive browsers / run tests on demand.
#
# Self-contained: the docker-compose.yml is written inline so this step
# doesn't depend on cloning the AI-IDE meta-repo.

hdr "Step 8 / 9 — Docker + Playwright + Chromium container"

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
    # Pass GEMINI_API_KEY through to the container for the
    # install-hyperframes skill's AI asset generation. Read from the
    # shell env at compose-up time; empty string if not set on host.
    # Operators set the actual value in /etc/workspace.env (which the
    # Terraform wrapper user-data writes) — that file is sourced into
    # the shell where this compose command runs, so the var lands here.
    environment:
      - GEMINI_API_KEY=\${GEMINI_API_KEY:-}
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

done_step "Step 8 / 9 — Playwright Docker container"

# ────────────────────────────────────────────────────────────────────
# Step 8.5 — ONLYOFFICE Docs Server (docs:4000 + sheets:4001)
# ────────────────────────────────────────────────────────────────────
#
# Two ONLYOFFICE Docs Server containers, one per service identity:
#   - ai-ide-onlyoffice-docs   on 127.0.0.1:4000  (DOCX editor)
#   - ai-ide-onlyoffice-sheets on 127.0.0.1:4001  (XLSX editor)
#
# Both share OFFICE_JWT_SECRET (set in /etc/workspace.env by user-data)
# so the same backend can sign editor configs / callback tokens for either
# container. Each gets its own data volumes — sessions and document keys
# survive container restarts but stay isolated per-editor.
#
# Public access is only via the per-user Traefik on :80 routing the
# subdomains docs-$USER_ID.$DOMAIN / sheets-$USER_ID.$DOMAIN to these
# ports (proxy router's DEFAULT_SERVICES). Direct external access is
# blocked because the containers bind 127.0.0.1.

hdr "Step 8.5 — ONLYOFFICE Docs Server (docs + sheets)"

readonly ONLYOFFICE_DIR=/opt/onlyoffice
readonly ONLYOFFICE_IMAGE="onlyoffice/documentserver:8.3"

# Re-source /etc/workspace.env to make sure OFFICE_JWT_SECRET is in scope
# (user-data already exported it for the parent shell; we're in a sub-
# shell here, so source defensively).
if [ -f /etc/workspace.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/workspace.env
  set +a
fi

if [ -z "${OFFICE_JWT_SECRET:-}" ]; then
  err "OFFICE_JWT_SECRET is missing from /etc/workspace.env — refusing to start ONLYOFFICE"
  exit 1
fi

log "Creating data volumes under ${ONLYOFFICE_DIR}"
mkdir -p \
  "${ONLYOFFICE_DIR}/docs/logs"   "${ONLYOFFICE_DIR}/docs/data"   \
  "${ONLYOFFICE_DIR}/docs/lib"    "${ONLYOFFICE_DIR}/docs/db"     \
  "${ONLYOFFICE_DIR}/sheets/logs" "${ONLYOFFICE_DIR}/sheets/data" \
  "${ONLYOFFICE_DIR}/sheets/lib"  "${ONLYOFFICE_DIR}/sheets/db"

log "Writing ${ONLYOFFICE_DIR}/docker-compose.yml"
# Two ONLYOFFICE containers. JWT_ENABLED=true forces every editor-config
# and callback payload to be signed — the backend that mounts editors
# must use OFFICE_JWT_SECRET to sign or validation fails. Each container
# binds 127.0.0.1 only so the only ingress is via per-user Traefik.
cat > "${ONLYOFFICE_DIR}/docker-compose.yml" <<EOF
services:
  docs:
    image: ${ONLYOFFICE_IMAGE}
    container_name: ai-ide-onlyoffice-docs
    restart: unless-stopped
    ports:
      - "127.0.0.1:4000:80"
    environment:
      - JWT_ENABLED=true
      - JWT_SECRET=\${OFFICE_JWT_SECRET}
      - WOPI_ENABLED=false
    volumes:
      - ${ONLYOFFICE_DIR}/docs/logs:/var/log/onlyoffice
      - ${ONLYOFFICE_DIR}/docs/data:/var/www/onlyoffice/Data
      - ${ONLYOFFICE_DIR}/docs/lib:/var/lib/onlyoffice
      - ${ONLYOFFICE_DIR}/docs/db:/var/lib/postgresql
      # Force ONLYOFFICE to generate https:// asset URLs (see nginx patch
      # below) — the per-user Traefik proxy terminates TLS but doesn't
      # forward X-Forwarded-Proto, so without this the editor emits
      # http:// URLs and the browser blocks them as Mixed Content.
      - ${ONLYOFFICE_DIR}/nginx/http-common.conf:/etc/onlyoffice/documentserver/nginx/includes/http-common.conf:ro

  sheets:
    image: ${ONLYOFFICE_IMAGE}
    container_name: ai-ide-onlyoffice-sheets
    restart: unless-stopped
    ports:
      - "127.0.0.1:4001:80"
    environment:
      - JWT_ENABLED=true
      - JWT_SECRET=\${OFFICE_JWT_SECRET}
      - WOPI_ENABLED=false
    volumes:
      - ${ONLYOFFICE_DIR}/sheets/logs:/var/log/onlyoffice
      - ${ONLYOFFICE_DIR}/sheets/data:/var/www/onlyoffice/Data
      - ${ONLYOFFICE_DIR}/sheets/lib:/var/lib/onlyoffice
      - ${ONLYOFFICE_DIR}/sheets/db:/var/lib/postgresql
      # Force https:// asset URLs — see the docs service + nginx patch.
      - ${ONLYOFFICE_DIR}/nginx/http-common.conf:/etc/onlyoffice/documentserver/nginx/includes/http-common.conf:ro
EOF

# Also drop a .env file alongside the compose file so an operator running
# `docker compose up -d` by hand picks up the secret without sourcing
# /etc/workspace.env. Compose reads it automatically.
cat > "${ONLYOFFICE_DIR}/.env" <<EOF
OFFICE_JWT_SECRET=${OFFICE_JWT_SECRET}
EOF
chmod 600 "${ONLYOFFICE_DIR}/.env"

log "Pulling ${ONLYOFFICE_IMAGE} (~700MB — first time only)"
docker pull "$ONLYOFFICE_IMAGE" 2>&1 | indent
ok "Image pulled"

# --- Force ONLYOFFICE nginx to always emit https:// URLs ---
#
# The per-user Traefik proxy terminates TLS but does NOT forward
# X-Forwarded-Proto to these containers. ONLYOFFICE's nginx therefore
# defaults its $the_scheme map to $scheme (= http) and generates http://
# internal asset URLs. Inside the https iframe that's a Mixed Content
# error, which blocks the ai-agent-bridge plugin from loading — so the
# docs-agent / sheets-agent bridges never get a connected editor.
#
# Fix: extract the stock http-common.conf from the image, rewrite the
# `$the_scheme` map to a constant `https`, and bind-mount it read-only
# into both containers (volumes added in the compose file above). The
# host copy persists, so the patch re-applies automatically on every
# container restart — no manual re-patching after a reboot.
NGINX_INC="${ONLYOFFICE_DIR}/nginx/http-common.conf"
mkdir -p "${ONLYOFFICE_DIR}/nginx"
if [ ! -f "$NGINX_INC" ]; then
  log "Extracting + patching nginx http-common.conf for forced HTTPS"
  tmp_cid=$(docker create "$ONLYOFFICE_IMAGE")
  docker cp "${tmp_cid}:/etc/onlyoffice/documentserver/nginx/includes/http-common.conf" "$NGINX_INC"
  docker rm "$tmp_cid" >/dev/null 2>&1 || true
  # Replace the whole `map <args> $the_scheme { ... }` block (multi-line,
  # no nested braces) with a constant-https map. perl is always present
  # on Ubuntu; -0777 slurps the file so the regex spans newlines.
  perl -0777 -i -pe \
    's/map\s+\S+\s+\$the_scheme\s*\{[^}]*\}/map \$host \$the_scheme {\n    default https;\n}/s' \
    "$NGINX_INC"
  if grep -q 'default https;' "$NGINX_INC"; then
    ok "  nginx http-common.conf patched (\$the_scheme → https)"
  else
    warn "  nginx patch did not apply cleanly — check ${NGINX_INC}"
  fi
else
  log "  nginx http-common.conf already present — leaving it"
fi

# Systemd unit so the compose stack survives reboots without depending on
# the workspace.service or the AI-IDE backend. ExecStart= uses docker
# compose v2 (already installed alongside docker-ce in Step 8).
log "Installing /etc/systemd/system/ai-ide-onlyoffice.service"
cat > /etc/systemd/system/ai-ide-onlyoffice.service <<EOF
[Unit]
Description=ONLYOFFICE Docs Server (docs:4000 + sheets:4001)
Requires=docker.service
After=docker.service traefik.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=/etc/workspace.env
WorkingDirectory=${ONLYOFFICE_DIR}
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ai-ide-onlyoffice.service 2>&1 | indent

# Quick sanity check — both containers should be up
sleep 3
for c in ai-ide-onlyoffice-docs ai-ide-onlyoffice-sheets; do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
    ok "  ${c}: running"
  else
    warn "  ${c}: not running yet (cold start can take ~30s — check 'docker logs ${c}')"
  fi
done

done_step "Step 8.5 — ONLYOFFICE Docs Server"

# ────────────────────────────────────────────────────────────────────
# Step 8.6 — docs-agent + sheets-agent sidecars
# ────────────────────────────────────────────────────────────────────
#
# Two long-running Node processes, one per editor service:
#
#   ai-ide-docs-agent.service    AGENT_KIND=docs    PORT=4100
#   ai-ide-sheets-agent.service  AGENT_KIND=sheets  PORT=4101
#
# Both run the same source file (src/agent.ts under the cloned
# AIWorkspaceBackEnd repo) via tsx — no separate install, no separate
# repo, no extra npm install. The agent process owns:
#
#   - WS  /plugin   the ai-agent-bridge plugin (running inside the
#                   user's ONLYOFFICE editor iframe) connects here on
#                   load and stays open
#   - POST /cmd     backend MCP tools (docs_* / sheets_*) call this
#                   with { op, args } to forward commands into the
#                   editor's Asc.plugin.callCommand sandbox
#   - GET  /health  liveness + connected-editor count
#
# Traefik's per-user config (from DEFAULT_SERVICES on the proxy router,
# updated in Phase 1) already routes docs-agent-$USER_ID.$DOMAIN to
# 127.0.0.1:4100 and sheets-agent-$USER_ID.$DOMAIN to 127.0.0.1:4101.

hdr "Step 8.6 — docs-agent + sheets-agent sidecars"

make_agent_unit() {
  local svc="$1" kind="$2" port="$3"
  cat > "/etc/systemd/system/${svc}.service" <<UNITEOF
[Unit]
Description=AI-IDE ${kind}-agent (port ${port}) — WS bridge to ONLYOFFICE plugin
After=network.target ai-ide-backend.service ai-ide-onlyoffice.service
Wants=ai-ide-onlyoffice.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${PROJECT_DIR}/backend
EnvironmentFile=/etc/workspace.env
Environment=NODE_ENV=production
Environment=AGENT_KIND=${kind}
Environment=HOST=0.0.0.0
Environment=PORT=${port}
# tsx is already installed by the backend's npm install (Step 6) — invoke
# via the local node_modules .bin so we don't need a global install.
ExecStart=${PROJECT_DIR}/backend/node_modules/.bin/tsx src/agent.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF
}

log "Writing systemd units for docs-agent (:4100) and sheets-agent (:4101)"
make_agent_unit ai-ide-docs-agent   docs   4100
make_agent_unit ai-ide-sheets-agent sheets 4101

systemctl daemon-reload
systemctl enable --now ai-ide-docs-agent.service   2>&1 | indent
systemctl enable --now ai-ide-sheets-agent.service 2>&1 | indent

# Brief sanity check
sleep 2
for svc in ai-ide-docs-agent ai-ide-sheets-agent; do
  state=$(systemctl is-active "$svc" || true)
  if [ "$state" = "active" ]; then
    ok "  ${svc}: ${state}"
  else
    warn "  ${svc}: ${state} (check 'journalctl -u ${svc} -e' for details)"
  fi
done

done_step "Step 8.6 — docs-agent + sheets-agent sidecars"

# ────────────────────────────────────────────────────────────────────
# Step 9 / 9 — Service boot-restoration (tmux recipes survive reboots)
# ────────────────────────────────────────────────────────────────────
#
# Every long-running project the user starts via Claude (dev servers,
# Odoo, Python apps, etc.) is wrapped in tmux per the system-prompt
# persistence rule. tmux survives browser close, but NOT EC2 reboots.
#
# This step installs the missing piece: a systemd oneshot that runs on
# boot, iterates `~/<user>/.ai-ide/services/*.sh` recipes, and starts
# each in a fresh tmux session named after the recipe.

hdr "Step 9 / 9 — Service boot-restoration (tmux recipes)"

if command -v tmux >/dev/null 2>&1; then
  skip "tmux already installed ($(tmux -V))"
else
  log "Installing tmux"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq 2>&1 | indent
  apt-get install -y --no-install-recommends tmux 2>&1 | indent
  ok "tmux installed: $(tmux -V)"
fi

log "Creating recipes folder at ${TARGET_HOME}/.ai-ide/services/"
as_user mkdir -p "${TARGET_HOME}/.ai-ide/services"

log "Installing /usr/local/bin/ai-ide-restart-services.sh"
cat > /usr/local/bin/ai-ide-restart-services.sh <<'HELPER_EOF'
#!/usr/bin/env bash
# ai-ide-restart-services.sh — replay tmux recipes on boot.
set -uo pipefail
readonly TARGET_USER="${1:-ubuntu}"
readonly TARGET_HOME="/home/${TARGET_USER}"
readonly SERVICES_DIR="${TARGET_HOME}/.ai-ide/services"

[ -d "$SERVICES_DIR" ] || { echo "[ai-ide-services] no ${SERVICES_DIR}"; exit 0; }
command -v tmux >/dev/null 2>&1 || { echo "[ai-ide-services] tmux missing"; exit 1; }

shopt -s nullglob
recipes=("$SERVICES_DIR"/*.sh)
[ ${#recipes[@]} -eq 0 ] && { echo "[ai-ide-services] no recipes"; exit 0; }

sleep 5  # let postgres/docker fully accept connections

for recipe in "${recipes[@]}"; do
  name=$(basename "$recipe" .sh)
  sudo -u "$TARGET_USER" tmux kill-session -t "$name" 2>/dev/null || true
  echo "[ai-ide-services] starting recipe: $name"
  sudo -u "$TARGET_USER" tmux new -d -s "$name" "bash '$recipe'" \
    || echo "[ai-ide-services] WARN: failed $name"
done

echo "[ai-ide-services] done — ${#recipes[@]} recipe(s) launched"
HELPER_EOF
chmod 755 /usr/local/bin/ai-ide-restart-services.sh

log "Installing /etc/systemd/system/ai-ide-services.service"
cat > /etc/systemd/system/ai-ide-services.service <<EOF
[Unit]
Description=AI-IDE: replay user-registered tmux recipes after boot
After=network-online.target docker.service postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/ai-ide-restart-services.sh ${TARGET_USER}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ai-ide-services.service 2>&1 | indent || true
systemctl start ai-ide-services.service 2>&1 | indent || true

chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.ai-ide"

ok "Boot-restoration service installed and enabled"
done_step "Step 9 / 9 — Service boot-restoration"

# ────────────────────────────────────────────────────────────────────
# Step 9.5 — Auto service-snapshot + restore on boot / apt update
# ────────────────────────────────────────────────────────────────────
#
# Problem:  `apt upgrade` (or `apt-get dist-upgrade`) stops services that
#           own upgraded packages — after the run (or reboot) those services
#           stay down until someone manually restarts them.
#
# Solution:
#   1. APT DPkg::Pre-Invoke  → snapshot every running systemd service
#      and Docker container to /var/lib/service-manager/running-services.json
#   2. APT DPkg::Post-Invoke → restore any service from the snapshot that
#      is no longer active (covers upgrades that don't need a reboot)
#   3. systemd oneshot       → restore on every boot (covers upgrades that
#      require a reboot, or a manual `shutdown -r`)
#
# Manual use (SSH into the instance):
#   sudo service-manager.sh save     — take a snapshot right now
#   sudo service-manager.sh restore  — restore from last snapshot
#   service-manager.sh status        — compare snapshot vs current state

hdr "Step 9.5 — Auto service-snapshot + restore on boot/update"

log "Writing /usr/local/bin/service-manager.sh"
cat > /usr/local/bin/service-manager.sh <<'SVC_EOF'
#!/usr/bin/env bash
# service-manager.sh — dynamic snapshot + restore
# Captures: systemd services, Docker containers, tmux sessions (with window details), user processes
set -euo pipefail

SNAPSHOT_DIR="/var/lib/service-manager"
SNAPSHOT_FILE="$SNAPSHOT_DIR/running-services.json"
LOG_FILE="$SNAPSHOT_DIR/service-manager.log"
RECIPES_DIR="/home/ubuntu/.ai-ide/services"
UBUNTU_USER="ubuntu"
mkdir -p "$SNAPSHOT_DIR"

_log() {
  local ts; ts=$(date '+%Y-%m-%d %H:%M:%S')
  printf '[%s] [%s] %s\n' "$ts" "${2:-INFO}" "$1" | tee -a "$LOG_FILE"
}
_docker_ok() { command -v docker &>/dev/null && docker info &>/dev/null 2>&1; }
_tmux_ok()   { command -v tmux &>/dev/null; }

# Walk up /proc/PID/stat to check if $1 is a descendant of any PID in $2 (space-separated)
_has_ancestor_in() {
  local pid=$1 ancestors=$2 cur=$1
  while [[ "$cur" -gt 1 ]]; do
    [[ " $ancestors " == *" $cur "* ]] && return 0
    cur=$(awk '{print $4}' "/proc/$cur/stat" 2>/dev/null) || return 1
    [[ -z "$cur" || "$cur" == "0" ]] && return 1
  done
  return 1
}

_capture_systemd() {
  local svc_json="[" first=1
  while IFS= read -r s; do
    [[ -z "$s" ]] && continue
    local desc; desc=$(systemctl show "$s" -p Description --value 2>/dev/null || true)
    desc="${desc//\"/\\\"}"; [[ $first -eq 0 ]] && svc_json+=","
    svc_json+="{\"name\":\"$s\",\"description\":\"$desc\"}"; first=0
  done < <(systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}')
  echo "${svc_json}]"
}

_capture_docker() {
  ! _docker_ok && echo "[]" && return
  local arr=()
  while IFS='|' read -r name image; do
    [[ -z "$name" ]] && continue
    arr+=("{\"name\":\"$name\",\"image\":\"$image\"}")
  done < <(docker ps --format '{{.Names}}|{{.Image}}' 2>/dev/null)
  [[ ${#arr[@]} -gt 0 ]] && printf '[%s]' "$(IFS=','; echo "${arr[*]}")" || echo "[]"
}

_capture_tmux() {
  ! _tmux_ok && echo "[]" && return
  local sessions=()
  while IFS= read -r sess; do
    [[ -z "$sess" ]] && continue
    local windows="[" wfirst=1
    while IFS='|' read -r widx wname cmd path; do
      [[ $wfirst -eq 0 ]] && windows+=","
      cmd="${cmd//\"/\\\"}"; path="${path//\"/\\\"}"
      windows+="{\"index\":${widx},\"name\":\"${wname//\"/\\\"}\",\"cmd\":\"$cmd\",\"path\":\"$path\"}"
      wfirst=0
    done < <(tmux list-windows -t "$sess" \
      -F '#{window_index}|#{window_name}|#{pane_current_command}|#{pane_current_path}' 2>/dev/null || true)
    windows+="]"
    sessions+=("{\"name\":\"${sess//\"/\\\"}\",\"windows\":$windows}")
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
  [[ ${#sessions[@]} -gt 0 ]] && printf '[%s]' "$(IFS=','; echo "${sessions[*]}")" || echo "[]"
}

_capture_user_procs() {
  local tmux_pids=""
  _tmux_ok && tmux_pids=$(tmux list-panes -a -F '#{pane_pid}' 2>/dev/null | tr '\n' ' ' || true)
  local blacklist=" bash sh zsh fish dash tee grep awk sed cat less more tail head vim nano vi ps top htop "
  local procs=()
  while IFS=' ' read -r pid comm; do
    [[ -z "$pid" || ! -d "/proc/$pid" ]] && continue
    [[ "$blacklist" == *" $comm "* ]] && continue
    [[ -z "$(tr -d '\0' < "/proc/$pid/cmdline" 2>/dev/null)" ]] && continue
    grep -q 'system\.slice.*\.service' "/proc/$pid/cgroup" 2>/dev/null && continue
    [[ -n "$tmux_pids" ]] && _has_ancestor_in "$pid" "$tmux_pids" 2>/dev/null && continue
    local cmdline cwd
    cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | sed 's/ $//' || echo "$comm")
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo "unknown")
    cmdline="${cmdline//\"/\\\"}"; cwd="${cwd//\"/\\\"}"; comm="${comm//\"/\\\"}"
    procs+=("{\"pid\":$pid,\"comm\":\"$comm\",\"cmdline\":\"$cmdline\",\"cwd\":\"$cwd\"}")
  done < <(ps -u "$UBUNTU_USER" --no-headers -o pid,comm 2>/dev/null)
  [[ ${#procs[@]} -gt 0 ]] && printf '[%s]' "$(IFS=','; echo "${procs[*]}")" || echo "[]"
}

cmd_save() {
  _log "Snapshot save ho raha hai..."
  local svc_json docker_json tmux_json procs_json
  svc_json=$(_capture_systemd)
  docker_json=$(_capture_docker)
  tmux_json=$(_capture_tmux)
  procs_json=$(_capture_user_procs)
  printf '{\n  "saved_at": "%s",\n  "systemd_services": %s,\n  "docker_containers": %s,\n  "tmux_sessions": %s,\n  "user_procs": %s\n}\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$svc_json" "$docker_json" "$tmux_json" "$procs_json" > "$SNAPSHOT_FILE"
  python3 -c "
import json; d=json.load(open('$SNAPSHOT_FILE'))
print(f'  systemd:{len(d[chr(34)+\"systemd_services\"+chr(34)])} docker:{len(d[chr(34)+\"docker_containers\"+chr(34)])} tmux:{len(d[chr(34)+\"tmux_sessions\"+chr(34)])} procs:{len(d[chr(34)+\"user_procs\"+chr(34)])}')" 2>/dev/null | while read -r l; do _log "$l"; done
  _log "Snapshot saved → $SNAPSHOT_FILE"
}

cmd_restore() {
  [[ -f "$SNAPSHOT_FILE" ]] || { _log "Snapshot nahi mila — pehle 'save' chalao" ERROR; exit 1; }
  local saved_at
  saved_at=$(python3 -c "import json; print(json.load(open('$SNAPSHOT_FILE'))['saved_at'])" 2>/dev/null || echo "?")
  _log "Restore from snapshot ($saved_at)"
  local ok=0 fail=0 skip=0

  while IFS= read -r svc; do
    [[ -z "$svc" ]] && continue
    systemctl list-unit-files "$svc" &>/dev/null || { ((skip++)) || true; continue; }
    [[ "$(systemctl is-active "$svc" 2>/dev/null || true)" == "active" ]] && { ((skip++)) || true; continue; }
    if systemctl start "$svc" 2>/dev/null; then _log "Started: $svc"; ((ok++)) || true
    else _log "Failed: $svc" ERROR; ((fail++)) || true; fi
  done < <(python3 -c "import json
for s in json.load(open('$SNAPSHOT_FILE')).get('systemd_services',[]): print(s['name'])" 2>/dev/null)

  if _docker_ok; then
    while IFS= read -r c; do
      [[ -z "$c" ]] && continue
      local st; st=$(docker inspect --format '{{.State.Status}}' "$c" 2>/dev/null || echo "not_found")
      [[ "$st" == "running" || "$st" == "not_found" ]] && { ((skip++)) || true; continue; }
      if docker start "$c" &>/dev/null; then _log "Docker: $c"; ((ok++)) || true
      else ((fail++)) || true; fi
    done < <(python3 -c "import json
for c in json.load(open('$SNAPSHOT_FILE')).get('docker_containers',[]): print(c['name'])" 2>/dev/null)
  fi

  if _tmux_ok; then
    python3 - <<'PY'
import json, subprocess, os
SNAPSHOT = '/var/lib/service-manager/running-services.json'
RECIPES  = '/home/ubuntu/.ai-ide/services'
USER     = 'ubuntu'
d = json.load(open(SNAPSHOT))
for si in d.get('tmux_sessions', []):
    sess = si['name']
    r = subprocess.run(['tmux','has-session','-t',sess], capture_output=True)
    if r.returncode == 0:
        print(f'  [SKIP] tmux running: {sess}'); continue
    recipe = f'{RECIPES}/{sess}.sh'
    if os.path.exists(recipe):
        r2 = subprocess.run(['sudo','-u',USER,'tmux','new-session','-d','-s',sess,'bash',recipe])
        print(f"  {'[OK]' if r2.returncode==0 else '[ERR]'} tmux (recipe): {sess}"); continue
    windows = si.get('windows', [])
    if not windows:
        print(f'  [WARN] tmux {sess} — no recipe, no saved windows'); continue
    first = windows[0]
    r2 = subprocess.run(['sudo','-u',USER,'tmux','new-session','-d','-s',sess,'-c',first['path'],first['cmd']])
    if r2.returncode != 0:
        print(f'  [ERR] tmux create failed: {sess}'); continue
    for w in windows[1:]:
        subprocess.run(['sudo','-u',USER,'tmux','new-window','-t',sess,'-c',w['path'],'-n',w['name'],w['cmd']], capture_output=True)
    print(f"  [OK]  tmux restored (saved commands): {sess} — {len(windows)} window(s)")

for proc in d.get('user_procs', []):
    r = subprocess.run(['pgrep','-u',USER,'-f',proc['cmdline'][:60]], capture_output=True)
    if r.returncode == 0:
        print(f"  [SKIP] running: {proc['comm']}"); continue
    sname = f"proc-{proc['comm']}"
    r2 = subprocess.run(['sudo','-u',USER,'tmux','new-session','-d','-s',sname,'-c',proc['cwd'],proc['cmdline']], capture_output=True)
    print(f"  {'[OK]' if r2.returncode==0 else '[WARN]'} proc: {proc['comm']} — {proc['cmdline'][:70]}")
PY
  fi

  _log "Restore done — ok:$ok fail:$fail skip:$skip"
}

cmd_status() {
  python3 - <<'PY'
import json, subprocess, os

SNAPSHOT = '/var/lib/service-manager/running-services.json'
RECIPES  = '/home/ubuntu/.ai-ide/services'

if not os.path.exists(SNAPSHOT):
    print("No snapshot found. Run: sudo service-manager.sh save"); exit(0)

d = json.load(open(SNAPSHOT))
print(f"\nSnapshot : {d['saved_at']}")
print(f"Systemd: {len(d['systemd_services'])}  Docker: {len(d['docker_containers'])}  "
      f"tmux: {len(d.get('tmux_sessions',[]))}  procs: {len(d.get('user_procs',[]))}\n")

print("=== Systemd Services ===")
for s in d['systemd_services']:
    r = subprocess.run(['systemctl','is-active',s['name']], capture_output=True, text=True)
    print(f"  {'[OK]' if r.stdout.strip()=='active' else '[--]'} {s['name']}")

if d['docker_containers']:
    print("\n=== Docker Containers ===")
    for c in d['docker_containers']:
        r = subprocess.run(['docker','inspect','--format','{{.State.Status}}',c['name']], capture_output=True, text=True)
        state = r.stdout.strip() or 'not_found'
        print(f"  {'[OK]' if state=='running' else '[--]'} {c['name']} ({c['image']}) — {state}")

r = subprocess.run(['tmux','list-panes','-a','-F',
                    '#{session_name}|#{window_index}|#{pane_current_command}|#{pane_current_path}'],
                   capture_output=True, text=True)
live = {}
for line in r.stdout.strip().splitlines():
    if not line: continue
    parts = line.split('|', 3)
    if len(parts) == 4:
        live.setdefault(parts[0], []).append((parts[1], parts[2], parts[3]))

if d.get('tmux_sessions') or live:
    print("\n=== tmux Sessions ===")
    saved_names = set()
    for si in d.get('tmux_sessions', []):
        sess = si['name']; saved_names.add(sess)
        alive = sess in live
        recipe = '(recipe)' if os.path.exists(f"{RECIPES}/{sess}.sh") else ''
        print(f"  {'[OK]' if alive else '[--]'} {sess} {recipe}")
        if alive:
            for widx, cmd, path in live[sess]:
                print(f"         [{widx}] {cmd:<25}  <- {path}")
        else:
            for w in si.get('windows', []):
                print(f"         [{w['index']}] {w['cmd']:<25}  <- {w['path']}  (saved)")
    new_sess = set(live.keys()) - saved_names
    if new_sess:
        print("\n  -- Live (not in snapshot — run save to capture) --")
        for sess in sorted(new_sess):
            print(f"  [NEW] {sess}")
            for widx, cmd, path in live[sess]:
                print(f"         [{widx}] {cmd:<25}  <- {path}")

if d.get('user_procs'):
    print("\n=== User Processes ===")
    r = subprocess.run(['ps','-u','ubuntu','--no-headers','-o','comm'], capture_output=True, text=True)
    running = set(r.stdout.strip().splitlines())
    for proc in d['user_procs']:
        icon = '[OK]' if proc['comm'] in running else '[--]'
        print(f"  {icon} {proc['comm']}")
        print(f"         {proc['cmdline'][:90]}")
        print(f"         cwd: {proc['cwd']}")
print()
PY
}

cmd_watch() {
  local interval="${WATCHDOG_INTERVAL:-30}"
  _log "Watchdog started — interval: ${interval}s"

  while true; do
    if [[ ! -f "$SNAPSHOT_FILE" ]]; then
      sleep "$interval"; continue
    fi

    # ── systemd ──
    while IFS= read -r svc; do
      [[ -z "$svc" ]] && continue
      [[ "$(systemctl is-active "$svc" 2>/dev/null || echo inactive)" == "active" ]] && continue
      _log "DEAD: $svc — restarting" WARN
      systemctl start "$svc" 2>/dev/null \
        && _log "RESTARTED: $svc" \
        || _log "RESTART FAILED: $svc" ERROR
    done < <(python3 -c "import json
for s in json.load(open('$SNAPSHOT_FILE')).get('systemd_services',[]): print(s['name'])" 2>/dev/null)

    # ── Docker ──
    if _docker_ok; then
      while IFS='|' read -r name _image; do
        [[ -z "$name" ]] && continue
        state=$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo "not_found")
        [[ "$state" == "running" || "$state" == "not_found" ]] && continue
        _log "DEAD: docker $name (state=$state) — restarting" WARN
        docker start "$name" &>/dev/null \
          && _log "RESTARTED: docker $name" \
          || _log "RESTART FAILED: docker $name" ERROR
      done < <(python3 -c "import json
for c in json.load(open('$SNAPSHOT_FILE')).get('docker_containers',[]): print(c['name']+'|'+c['image'])" 2>/dev/null)
    fi

    # ── tmux ──
    if _tmux_ok; then
      python3 - <<'PYWATCH'
import json, subprocess, os
SNAPSHOT = '/var/lib/service-manager/running-services.json'
RECIPES  = '/home/ubuntu/.ai-ide/services'
USER     = 'ubuntu'
d = json.load(open(SNAPSHOT))
for si in d.get('tmux_sessions', []):
    sess = si['name']
    r = subprocess.run(['tmux', 'has-session', '-t', sess], capture_output=True)
    if r.returncode == 0: continue
    print(f'DEAD: tmux session "{sess}" — restarting', flush=True)
    recipe = f'{RECIPES}/{sess}.sh'
    if os.path.exists(recipe):
        r2 = subprocess.run(['sudo', '-u', USER, 'tmux', 'new-session', '-d', '-s', sess, 'bash', recipe])
        print(f"{'RESTARTED' if r2.returncode==0 else 'RESTART FAILED'}: tmux {sess}", flush=True)
        continue
    windows = si.get('windows', [])
    if not windows:
        print(f'RESTART SKIPPED: tmux {sess} — no recipe, no saved windows', flush=True); continue
    first = windows[0]
    r2 = subprocess.run(['sudo', '-u', USER, 'tmux', 'new-session', '-d',
                         '-s', sess, '-c', first['path'], first['cmd']])
    if r2.returncode == 0:
        for w in windows[1:]:
            subprocess.run(['sudo', '-u', USER, 'tmux', 'new-window', '-t', sess,
                            '-c', w['path'], '-n', w['name'], w['cmd']], capture_output=True)
        print(f'RESTARTED: tmux {sess} (from saved windows)', flush=True)
    else:
        print(f'RESTART FAILED: tmux {sess}', flush=True)
PYWATCH
    fi

    sleep "$interval"
  done
}

case "${1:-}" in
  save)    cmd_save ;;
  restore) cmd_restore ;;
  status)  cmd_status ;;
  watch)   cmd_watch ;;
  *)
    echo "Usage: sudo $0 {save|restore|status|watch}"
    echo "  save     — sab running cheezein snapshot karo"
    echo "  restore  — snapshot se sab wapas start karo"
    echo "  status   — current vs snapshot compare karo"
    echo "  watch    — watchdog: jo bhi mare use restart karo (daemon)"
    exit 1
    ;;
esac
SVC_EOF
chmod 755 /usr/local/bin/service-manager.sh
ok "service-manager.sh installed at /usr/local/bin/"

log "Installing service-manager-watchdog.service (auto-restart died services)"
cat > /etc/systemd/system/service-manager-watchdog.service <<'WATCHDOG_EOF'
[Unit]
Description=Service Watchdog — auto-restart died services every 30s
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/service-manager.sh watch
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
WATCHDOG_EOF

log "APT hooks install ho rahe hain (pre-invoke: save, post-invoke: restore)"
# DPkg::Pre-Invoke  fires before dpkg processes any package — captures the
# running-services list while everything is still up.
# DPkg::Post-Invoke fires after dpkg finishes — restores anything that got
# stopped during the upgrade without needing a reboot.
cat > /etc/apt/apt.conf.d/80-service-snapshot <<'APT_EOF'
DPkg::Pre-Invoke  { "[ -x /usr/local/bin/service-manager.sh ] && /usr/local/bin/service-manager.sh save    2>/dev/null || true"; };
DPkg::Post-Invoke { "[ -x /usr/local/bin/service-manager.sh ] && /usr/local/bin/service-manager.sh restore 2>/dev/null || true"; };
APT_EOF
ok "APT hooks → /etc/apt/apt.conf.d/80-service-snapshot"

log "Installing systemd restore-on-boot service"
cat > /etc/systemd/system/service-manager-restore.service <<'UNIT_EOF'
[Unit]
Description=Restore services from pre-update snapshot (service-manager)
After=network.target docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/service-manager.sh restore
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl enable service-manager-restore.service
ok "service-manager-restore.service enabled (boot pe auto-restore)"

# Initial snapshot — captures the services registered in steps above so the
# very first `apt upgrade` has a reference point to restore from.
log "Initial snapshot le raha hai..."
/usr/local/bin/service-manager.sh save
ok "Initial snapshot → /var/lib/service-manager/running-services.json"

systemctl daemon-reload
systemctl enable --now service-manager-watchdog.service
ok "Watchdog enabled — har 30s mein check karega, jo mara restart karega"

done_step "Step 9.5 — Auto service-snapshot + restore + watchdog"

# ────────────────────────────────────────────────────────────────────
# Step 9.6 — Service watchdog (polls every Traefik-registered service)
# ────────────────────────────────────────────────────────────────────
#
# The healthcheck timers from Step 7 cover backend + frontend only. This
# watchdog is the catch-all: it pulls the per-user Traefik config from
# the central proxy router on every probe round, so every service the
# user has registered via `register_service` (in addition to the
# defaults: frontend, api, ide, docs, sheets, docs-agent, sheets-agent)
# is monitored automatically. Three consecutive probe failures → restart
# the underlying systemd unit / docker container / tmux recipe. Five
# failed restart cycles in a row → set a "give up" flag so we don't
# restart-storm a permanently broken service.

hdr "Step 9.6 — Service watchdog (probes every Traefik-registered service)"

log "Installing /usr/local/bin/ai-ide-watchdog.sh"
cat > /usr/local/bin/ai-ide-watchdog.sh <<'WATCHDOG_EOF'
#!/usr/bin/env bash
# /usr/local/bin/ai-ide-watchdog.sh
#
# Watchdog for every service Traefik routes to in this workspace.
#
# Source of truth for the service list: the central proxy router's
# /api/traefik/user/$USER_ID, polled each round so newly-registered
# services are picked up automatically.
#
# Restart strategy per service is auto-discovered on first sight and
# cached in /var/lib/ai-ide/restarters (key=value lines). Discovery
# priority:
#   1. ~/.ai-ide/services/<name>.sh recipe (cached as "RECIPE")
#   2. <name>.service systemd unit (cached as "systemctl restart <name>")
#   3. Docker container named <name>  (cached as "docker restart <name>")
#   4. Nothing → cached as empty string; service is skipped silently.
#
# The cache file is human-editable: change a value to override a wrong
# guess, delete a line to re-trigger discovery on the next round. A few
# defaults (frontend / api / ide / docs / sheets / docs-agent /
# sheets-agent) are hard-coded in this script so the cache file isn't
# needed to bootstrap.
#
# Probe: curl http://127.0.0.1:<port>/. -f is intentionally omitted: any
# HTTP response (200/302/404/5xx) means the process is alive; only
# connect-refused / timeout counts as a failure.
#
# Cadence: 60s initial grace, 30s probe interval. 3 consecutive failures
# → restart. 5 failed restart cycles in a row → "give up" flag (keep
# monitoring so a manual recovery is detected, but stop restarting).

set -uo pipefail

if [ -f /etc/workspace.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/workspace.env
  set +a
fi

PROXY_ROUTER_URL="${PROXY_ROUTER_URL:-}"
USER_ID="${USER_ID:-}"
if [ -z "$PROXY_ROUTER_URL" ] || [ -z "$USER_ID" ]; then
  echo "[ai-ide-watchdog] PROXY_ROUTER_URL or USER_ID missing from /etc/workspace.env — exiting" >&2
  exit 1
fi

readonly PROXY_ROUTER_URL USER_ID
readonly TARGET_USER="${TARGET_USER:-ubuntu}"
readonly TARGET_HOME="/home/${TARGET_USER}"
readonly RECIPES_DIR="${TARGET_HOME}/.ai-ide/services"
readonly CACHE_DIR="/var/lib/ai-ide"
readonly CACHE_FILE="${CACHE_DIR}/restarters"

readonly PROBE_INTERVAL=30
readonly FAIL_THRESHOLD=3
readonly MAX_RESTART_ATTEMPTS=5
readonly PROBE_TIMEOUT=5
readonly INITIAL_GRACE=60
readonly DISCOVER_TIMEOUT=3

declare -A RESTARTERS=(
  ["frontend"]="systemctl restart ai-ide-frontend"
  ["api"]="systemctl restart ai-ide-backend"
  ["ide"]="systemctl restart code-server@${TARGET_USER}"
  ["docs"]="docker restart ai-ide-onlyoffice-docs"
  ["sheets"]="docker restart ai-ide-onlyoffice-sheets"
  ["docs-agent"]="systemctl restart ai-ide-docs-agent"
  ["sheets-agent"]="systemctl restart ai-ide-sheets-agent"
)

declare -A FAILS RESTARTS GIVE_UP IGNORED

ts()    { date -u +%FT%TZ; }
slog()  { echo "[ai-ide-watchdog $(ts)] $*"; }
swarn() { echo "[ai-ide-watchdog $(ts)] WARN $*" >&2; }

# ── cache I/O ───────────────────────────────────────────────────────
load_cache() {
  [ -f "$CACHE_FILE" ] || return 0
  local key val
  while IFS='=' read -r key val; do
    [[ -z "${key:-}" ]] && continue
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    RESTARTERS[$key]="$val"
  done < "$CACHE_FILE"
}

persist_cache() {
  load_cache  # Merge any manual edits before rewriting.
  mkdir -p "$CACHE_DIR"
  local tmp
  tmp=$(mktemp -p "$CACHE_DIR" .restarters.XXXXXX) || return 1
  {
    echo "# ai-ide watchdog restart strategies — auto-discovered + manual overrides."
    echo "# Format: <service_name>=<restart_command>"
    echo "# Special: RECIPE  = restart via ${RECIPES_DIR}/<name>.sh in tmux."
    echo "#         <empty>  = no strategy found; service is monitored but not restarted."
    echo "#"
    echo "# Edit to override a wrong guess. Delete a line to re-trigger"
    echo "# discovery on the next round."
    echo "#"
    local k
    for k in $(printf '%s\n' "${!RESTARTERS[@]}" | sort); do
      printf '%s=%s\n' "$k" "${RESTARTERS[$k]}"
    done
  } > "$tmp" && mv "$tmp" "$CACHE_FILE"
}

# ── discovery ───────────────────────────────────────────────────────
discover_restarter() {
  local name="$1"

  if [ -f "${RECIPES_DIR}/${name}.sh" ]; then
    echo "RECIPE"; return 0
  fi

  if timeout "$DISCOVER_TIMEOUT" systemctl cat "${name}.service" >/dev/null 2>&1; then
    echo "systemctl restart ${name}"; return 0
  fi

  if timeout "$DISCOVER_TIMEOUT" docker ps -a --format '{{.Names}}' 2>/dev/null \
       | grep -qFx "$name"; then
    echo "docker restart ${name}"; return 0
  fi

  return 1
}

# Make sure RESTARTERS has an entry for $name (empty allowed = known
# unmappable). Returns 0 if a usable strategy is on file, 1 otherwise.
ensure_strategy() {
  local name="$1"
  if [ -n "${RESTARTERS[$name]+x}" ]; then
    [ -n "${RESTARTERS[$name]}" ] && return 0 || return 1
  fi

  local cmd
  if cmd=$(discover_restarter "$name"); then
    RESTARTERS[$name]="$cmd"
    slog "learned: ${name} → ${cmd}"
  else
    RESTARTERS[$name]=""
    swarn "no restart strategy for '${name}' — looked for ${RECIPES_DIR}/${name}.sh, ${name}.service, docker container '${name}'"
  fi
  persist_cache
  [ -n "${RESTARTERS[$name]}" ]
}

# ── service ops ─────────────────────────────────────────────────────
fetch_services() {
  local body
  body=$(curl -sf --max-time 10 \
    "${PROXY_ROUTER_URL%/}/api/traefik/user/${USER_ID}" 2>/dev/null) || return 0
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    cfg = json.load(sys.stdin)
except Exception:
    sys.exit(0)
services = (cfg.get("http") or {}).get("services") or {}
for name, svc in services.items():
    url = (((svc.get("loadBalancer") or {}).get("servers") or [{}])[0]
           .get("url") or "")
    tail = url.rsplit(":", 1)[-1].split("/", 1)[0]
    if tail.isdigit():
        print(f"{name}\t{tail}")
'
}

probe() {
  local port="$1"
  curl -sS --max-time "$PROBE_TIMEOUT" -o /dev/null \
    "http://127.0.0.1:${port}/" 2>/dev/null
}

restart_service() {
  local name="$1"
  local cmd="${RESTARTERS[$name]:-}"

  if [ "$cmd" = "RECIPE" ]; then
    local recipe="${RECIPES_DIR}/${name}.sh"
    if [ ! -f "$recipe" ]; then
      swarn "recipe for ${name} disappeared (${recipe}) — clearing strategy"
      RESTARTERS[$name]=""
      persist_cache
      return 1
    fi
    slog "restart: ${name} → tmux recipe ${recipe}"
    sudo -u "$TARGET_USER" tmux kill-session -t "$name" 2>/dev/null || true
    sudo -u "$TARGET_USER" tmux new -d -s "$name" "bash '$recipe'"
    return $?
  fi

  if [ -n "$cmd" ]; then
    slog "restart: ${name} → ${cmd}"
    eval "$cmd"
    return $?
  fi

  return 1
}

# ── main ────────────────────────────────────────────────────────────
load_cache
slog "starting (interval=${PROBE_INTERVAL}s, threshold=${FAIL_THRESHOLD}, max_restarts=${MAX_RESTART_ATTEMPTS})"
slog "router=${PROXY_ROUTER_URL%/}  user_id=${USER_ID}  cache=${CACHE_FILE}"

# Persist once at startup so the defaults land in the cache file even
# if discovery never runs (makes the file a complete view).
persist_cache

sleep "$INITIAL_GRACE"

while :; do
  while IFS=$'\t' read -r name port; do
    [ -z "${name:-}" ] && continue

    if ! ensure_strategy "$name"; then
      if [ "${IGNORED[$name]:-0}" = "0" ]; then
        swarn "skipping '${name}:${port}' — drop a ${RECIPES_DIR}/${name}.sh recipe, install a ${name}.service unit, or run a docker container named '${name}' to enable auto-restart"
        IGNORED[$name]=1
      fi
      continue
    fi

    # A real strategy exists → re-probing is meaningful.
    IGNORED[$name]=0

    if probe "$port"; then
      if [ "${GIVE_UP[$name]:-0}" = "1" ]; then
        slog "recovered: ${name}:${port} responding again — clearing give-up flag"
      fi
      FAILS[$name]=0
      RESTARTS[$name]=0
      GIVE_UP[$name]=0
      continue
    fi

    FAILS[$name]=$(( ${FAILS[$name]:-0} + 1 ))
    slog "probe fail #${FAILS[$name]} on ${name}:${port}"

    if [ "${GIVE_UP[$name]:-0}" = "1" ]; then
      continue
    fi

    if [ "${FAILS[$name]}" -ge "$FAIL_THRESHOLD" ]; then
      RESTARTS[$name]=$(( ${RESTARTS[$name]:-0} + 1 ))
      slog "${name}:${port} failed ${FAILS[$name]} probes — restart attempt #${RESTARTS[$name]}/${MAX_RESTART_ATTEMPTS}"
      restart_service "$name" || swarn "restart command for ${name} returned non-zero"
      FAILS[$name]=0

      if [ "${RESTARTS[$name]}" -ge "$MAX_RESTART_ATTEMPTS" ]; then
        swarn "giving up on ${name}:${port} after ${RESTARTS[$name]} restart attempts — keeps monitoring but no further restarts until it recovers on its own"
        GIVE_UP[$name]=1
      fi
    fi
  done < <(fetch_services)

  sleep "$PROBE_INTERVAL"
done
WATCHDOG_EOF
chmod 755 /usr/local/bin/ai-ide-watchdog.sh

log "Installing /etc/systemd/system/ai-ide-watchdog.service"
cat > /etc/systemd/system/ai-ide-watchdog.service <<EOF
[Unit]
Description=AI-IDE watchdog (probes Traefik-registered services, restarts dead ones)
After=network-online.target ai-ide-backend.service ai-ide-frontend.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=/etc/workspace.env
ExecStart=/usr/local/bin/ai-ide-watchdog.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ai-ide-watchdog.service 2>&1 | indent
ok "Watchdog enabled — tail with 'journalctl -u ai-ide-watchdog -f'"
done_step "Step 9.6 — Service watchdog"

# ────────────────────────────────────────────────────────────────────
# Make sure .claude/skills dir exists for future skill installs
# ────────────────────────────────────────────────────────────────────

as_user mkdir -p "${TARGET_HOME}/.claude/skills"

# ────────────────────────────────────────────────────────────────────
# NOTE: ~/.claude/CLAUDE.md (which bakes USER_ID + PLATFORM_DOMAIN into
# its example URLs) is NOT written here — that's per-instance content
# and lives in provision.sh so each fresh AMI launch lands the right
# user's URLs in the file.
# ────────────────────────────────────────────────────────────────────

# ────────────────────────────────────────────────────────────────────
# Mark the AMI version so provision.sh can detect a baked image and skip
# anything that would otherwise re-do work that's already in the AMI.
# ────────────────────────────────────────────────────────────────────

AMI_VERSION="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$AMI_VERSION" > /etc/ai-ide-ami-version
chmod 644 /etc/ai-ide-ami-version

# ────────────────────────────────────────────────────────────────────
# Bake summary
# ────────────────────────────────────────────────────────────────────

hdr "Bake complete — ready to snapshot into an AMI"

cat <<EOF

  ${BOLD}${GREEN}✓ Workspace AMI bake finished.${NC}  Version: ${CYAN}${AMI_VERSION}${NC}

  Next steps (run from your admin workstation, NOT inside this EC2):
    ${DIM}1. Stop the instance:${NC}
       ${DIM}aws ec2 stop-instances --instance-ids <id> --profile phase1-deploy${NC}
    ${DIM}2. Wait for stopped state, then snapshot:${NC}
       ${DIM}aws ec2 create-image --instance-id <id> \\
         --name "ai-workspace-${AMI_VERSION}" \\
         --description "AI-IDE workspace baked $(date -u)" \\
         --no-reboot \\
         --profile phase1-deploy${NC}
    ${DIM}3. Plug the resulting AMI id into terraform/workspace tfvars as${NC}
       ${DIM}workspace_ami_id, or set WORKSPACE_AMI_ID in the landing-page env.${NC}

  Per-instance setup (USER_ID, OFFICE_JWT_SECRET, ~/.claude/CLAUDE.md,
  git pull on the repos, service restarts) is handled by provision.sh
  on every new instance launched from the AMI.

  ${BOLD}${YELLOW}⚠ SECURITY WARNING${NC}
    code-server is configured WITHOUT authentication and binds 0.0.0.0:${CODE_SERVER_PORT}.
    Restrict the EC2 SG, or enable auth in
    ${TARGET_HOME}/.config/code-server/config.yaml before exposing this AMI.

  ${BOLD}Bake log:${NC} ${CYAN}${LOG_FILE}${NC}

EOF
