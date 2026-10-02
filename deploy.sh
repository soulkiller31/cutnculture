#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# deploy.sh — One-command deploy script for Hostinger VPS
# Run this on your VPS: bash deploy.sh
# ─────────────────────────────────────────────────────────────────
set -e

REPO="https://github.com/soulkiller31/cutnculture.git"
APP_DIR="/var/www/cutnculture"
DOMAIN=""   # Set your domain here e.g. cutnculturesalon.cloud

echo ""
echo "═══════════════════════════════════════════"
echo "  CRM Salon — VPS Deploy Script"
echo "═══════════════════════════════════════════"
echo ""

# ── Step 1: Install Docker ───────────────────────────────────────
if ! command -v docker &> /dev/null; then
  echo "→ Installing Docker..."
  apt-get update -qq
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  echo "✓ Docker installed"
else
  echo "✓ Docker already installed: $(docker --version)"
fi

# ── Step 2: Install Docker Compose ──────────────────────────────
if ! command -v docker-compose &> /dev/null; then
  echo "→ Installing Docker Compose..."
  curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
    -o /usr/local/bin/docker-compose
  chmod +x /usr/local/bin/docker-compose
  echo "✓ Docker Compose installed"
else
  echo "✓ Docker Compose already installed: $(docker-compose --version)"
fi

# ── Step 3: Clone or update repo ────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "→ Pulling latest code..."
  cd "$APP_DIR"
  git pull origin main
else
  echo "→ Cloning repo..."
  mkdir -p "$APP_DIR"
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# ── Step 4: Check .env exists ───────────────────────────────────
if [ ! -f "$APP_DIR/backend/.env" ]; then
  echo ""
  echo "✗ ERROR: backend/.env not found!"
  echo "  The .env file should be in the repo (private)."
  echo "  If missing, create it: nano $APP_DIR/backend/.env"
  echo ""
  exit 1
fi
echo "✓ backend/.env found"

# ── Step 5: Set FRONTEND_URL in .env if domain is set ───────────
if [ -n "$DOMAIN" ]; then
  sed -i "s|FRONTEND_URL=.*|FRONTEND_URL=https://$DOMAIN|g" "$APP_DIR/backend/.env"
  sed -i "s|BACKEND_URL=.*|BACKEND_URL=https://$DOMAIN/api|g" "$APP_DIR/backend/.env"
  echo "✓ Domain set to: $DOMAIN"
fi

# ── Step 6: Build and start containers ──────────────────────────
echo "→ Building Docker images (this takes a few minutes)..."
cd "$APP_DIR"
docker-compose down --remove-orphans 2>/dev/null || true
docker-compose build --no-cache
docker-compose up -d
echo "✓ Containers started"

# ── Step 7: Show status ──────────────────────────────────────────
echo ""
echo "→ Container status:"
docker-compose ps

echo ""
echo "═══════════════════════════════════════════"
echo "  ✓ Deploy complete!"
echo ""
if [ -n "$DOMAIN" ]; then
  echo "  App running at: http://$DOMAIN"
  echo ""
  echo "  To enable SSL run:"
  echo "  docker-compose run --rm certbot certonly \\"
  echo "    --webroot -w /var/www/certbot \\"
  echo "    -d $DOMAIN --email your@email.com --agree-tos"
else
  echo "  App running at: http://$(curl -s ifconfig.me)"
  echo ""
  echo "  Set DOMAIN in this script to enable SSL"
fi
echo "═══════════════════════════════════════════"
echo ""

# ── Useful commands ──────────────────────────────────────────────
echo "  Useful commands:"
echo "  docker-compose logs -f backend    # backend logs"
echo "  docker-compose logs -f frontend   # frontend logs"
echo "  docker-compose restart backend    # restart backend"
echo "  docker-compose down               # stop everything"
echo ""
