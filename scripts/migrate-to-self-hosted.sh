#!/bin/bash
set -e

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"
CONVEX_DIR="$ROOT_DIR/packages/convex"
EXPORT_PATH="/tmp/convex-export.zip"

echo "=== Convex Cloud → Self-Hosted Migration ==="
echo ""

# Check required env vars
if [[ -z "$CONVEX_SELF_HOSTED_URL" ]]; then
  echo "Error: CONVEX_SELF_HOSTED_URL not set"
  echo "Set it to your self-hosted Convex backend URL (e.g., https://convex.codecast.sh)"
  exit 1
fi

if [[ -z "$CONVEX_SELF_HOSTED_ADMIN_KEY" ]]; then
  echo "Error: CONVEX_SELF_HOSTED_ADMIN_KEY not set"
  echo "Get it from Railway deploy logs or run generate_admin_key.sh on the backend container"
  exit 1
fi

echo "Self-hosted URL: $CONVEX_SELF_HOSTED_URL"
echo ""

# Step 1: Export from Convex Cloud
echo "Step 1: Exporting data from Convex Cloud..."
echo "  This may take a while depending on data size."
cd "$CONVEX_DIR"

# Temporarily use cloud config for export
CLOUD_DEPLOYMENT="dev:marvelous-meerkat-539"
CONVEX_DEPLOYMENT="$CLOUD_DEPLOYMENT" npx convex export --path "$EXPORT_PATH"
echo "  Exported to $EXPORT_PATH"
echo ""

# Step 2: Deploy functions to self-hosted
echo "Step 2: Deploying functions to self-hosted..."
npx convex deploy
echo "  Functions deployed"
echo ""

# Step 3: Set environment variables on self-hosted
echo "Step 3: Setting environment variables..."

set_env() {
  local key="$1"
  local value="$2"
  if [[ -n "$value" ]]; then
    npx convex env set "$key" "$value" 2>/dev/null && echo "  Set $key" || echo "  Warning: Failed to set $key"
  else
    echo "  Skipped $key (not set locally)"
  fi
}

# Read env vars from various sources
source_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    while IFS='=' read -r key value; do
      [[ "$key" =~ ^#.*$ ]] && continue
      [[ -z "$key" ]] && continue
      value="${value%\"}"
      value="${value#\"}"
      export "$key=$value" 2>/dev/null || true
    done < "$file"
  fi
}

# Source web env for GitHub credentials
source_env_file "$ROOT_DIR/packages/web/.env.local"

set_env "SITE_URL" "https://codecast.sh"
set_env "AUTH_GITHUB_ID" "$AUTH_GITHUB_ID"
set_env "AUTH_GITHUB_SECRET" "$AUTH_GITHUB_SECRET"

# These need to be set manually if not in env:
echo ""
echo "  The following env vars need manual configuration via the Convex dashboard"
echo "  or 'npx convex env set' if not already set:"
echo "    - AUTH_APPLE_ID"
echo "    - AUTH_APPLE_SECRET"
echo "    - RESEND_API_KEY"
echo "    - GITHUB_APP_ID"
echo "    - GITHUB_APP_PRIVATE_KEY"
echo "    - GITHUB_APP_WEBHOOK_SECRET"
echo "    - ANTHROPIC_API_KEY"
echo "    - JWKS"
echo "    - JWT_PRIVATE_KEY"
echo ""

# Step 4: Import data
echo "Step 4: Importing data to self-hosted..."
echo "  This is atomic -- queries won't see partial state during import."
npx convex import --replace-all "$EXPORT_PATH"
echo "  Data imported"
echo ""

cd "$ROOT_DIR"

echo "=== Migration Complete ==="
echo ""
echo "Next steps:"
echo "  1. Update GitHub OAuth callback URL to: ${CONVEX_SELF_HOSTED_URL}/api/auth/callback/github"
echo "  2. Update GitHub App webhook URL to: ${CONVEX_SELF_HOSTED_URL}/api/webhooks/github-app"
echo "  3. Update Apple Sign-In redirect URI"
echo "  4. Set NEXT_PUBLIC_CONVEX_URL=$CONVEX_SELF_HOSTED_URL on Railway web service"
echo "  5. Deploy web app (git push)"
echo "  6. Push CLI update with new default URL"
echo "  7. Verify: auth, realtime, CLI sync, webhooks, file storage, crons"
echo ""
echo "Rollback: Revert NEXT_PUBLIC_CONVEX_URL to https://marvelous-meerkat-539.convex.cloud"
