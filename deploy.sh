#!/usr/bin/env bash
# ============================================================
# deploy.sh — push Sea of Rouge to GitHub
# Target: https://github.com/lychees/lychees-Sea-of-Thieves-K3
#
# Usage:
#   bash deploy.sh            # commit & push (asks for a message if needed)
#   bash deploy.sh "message"  # commit with the given message & push
#
# Notes:
#   - The remote repo must already exist on GitHub (create it at
#     https://github.com/new if it doesn't — this script will tell you).
#   - HTTPS push uses your stored git credentials (Git Credential Manager).
# ============================================================
set -euo pipefail

REPO_URL="https://github.com/lychees/lychees-Sea-of-Thieves-K3.git"
BRANCH="main"
MSG="${1:-Update Sea of Rouge}"

cd "$(dirname "$0")"

echo "==> Target: $REPO_URL"

# 1. Init repo if needed
if [ ! -d .git ]; then
  echo "==> Initializing git repository..."
  git init -b "$BRANCH"
fi

# 2. Make sure we're on the target branch
current_branch="$(git symbolic-ref --short -q HEAD || echo '')"
if [ -n "$current_branch" ] && [ "$current_branch" != "$BRANCH" ]; then
  git branch -M "$BRANCH"
fi

# 3. Configure remote
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

# 4. Check the remote repo exists / credentials work
echo "==> Checking remote access..."
if ! git ls-remote origin >/dev/null 2>&1; then
  echo ""
  echo "!! Cannot reach the remote repository."
  echo "   - Create it first: https://github.com/new  (name: lychees-Sea-of-Thieves-K3)"
  echo "   - Or check your GitHub credentials / network."
  exit 1
fi

# 5. Stage & commit (skip commit if nothing changed)
git add -A
if git diff --cached --quiet; then
  echo "==> Nothing new to commit."
else
  echo "==> Committing: $MSG"
  git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo 'pirate')}" \
      -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo 'pirate@sea-of-rouge.local')}" \
      commit -m "$MSG"
fi

# 6. Push (set upstream; merge remote README/license if the repo was created with one)
echo "==> Pushing to origin/$BRANCH..."
if ! git push -u origin "$BRANCH" 2>/dev/null; then
  echo "==> Remote has commits we don't have — rebasing on top..."
  git pull --rebase origin "$BRANCH"
  git push -u origin "$BRANCH"
fi

echo ""
echo "==> Done! 🏴‍☠️  https://github.com/lychees/lychees-Sea-of-Thieves-K3"
