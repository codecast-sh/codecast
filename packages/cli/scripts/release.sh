#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Load deploy secrets
if [ -f .env.deploy ]; then
  export $(cat .env.deploy | xargs)
else
  echo "Error: .env.deploy not found"
  echo "Create it with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
  exit 1
fi

# Check for version bump argument
BUMP_TYPE="${1:-patch}"
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: ./scripts/release.sh [patch|minor|major]"
  echo "  patch: 0.1.0 -> 0.1.1 (default)"
  echo "  minor: 0.1.0 -> 0.2.0"
  echo "  major: 0.1.0 -> 1.0.0"
  exit 1
fi

# Get current version
OLD_VERSION=$(jq -r '.version' package.json)

# Bump version
npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION=$(jq -r '.version' package.json)

echo "Releasing v$NEW_VERSION (was v$OLD_VERSION)"

# Update version in update.ts
sed -i '' "s/const VERSION = \"$OLD_VERSION\"/const VERSION = \"$NEW_VERSION\"/" src/update.ts

# Deploy to R2
./scripts/deploy.sh

# Commit and push
git add package.json src/update.ts
git commit -m "release: v$NEW_VERSION"
git push

echo ""
echo "Released v$NEW_VERSION"
