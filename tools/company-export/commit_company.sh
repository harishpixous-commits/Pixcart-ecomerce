#!/usr/bin/env bash
# Replace a company repository's history with one clean commit of the exported tree and push it.
#   bash commit_company.sh web|mobile "<expected remote main sha>"
# Keeps the old history in the local branch backup/history-2026-11-26 (never pushed). Neutral identity, no trailers.
set -euo pipefail
which="$1"; expect="$2"
case "$which" in
  web)    dir=/c/Users/haris/Downloads/Pix-ShopCart_Web
          subject="PixCart website and API: Angular 21, ASP.NET Core .NET 10, MySQL 8.4"
          body="Storefront with four themes, seller hub, delivery partner pages and admin panel. REST API on MySQL (Dapper)
with background jobs, Razorpay payments, notifications, the staff AI assistant and the shop assistant. xUnit tests
against MySQL, screen contract tests, and the Windows/IIS package script." ;;
  mobile) dir=/c/Users/haris/Downloads/Pix-ShopCart_Mobile
          subject="PixCart mobile apps: Flutter customer, delivery partner and seller apps"
          body="Three native apps sharing pixcart_core (API client, session, site settings, theme tokens) and pixcart_ui
(shared widgets). CI analyzes and tests every push; the release workflow builds signed APKs." ;;
  *) echo "web or mobile"; exit 2 ;;
esac
cd "$dir"
git fetch -q origin
remote=$(git rev-parse origin/main)
[ "$remote" = "$expect" ] || { echo "remote main is $remote, expected $expect: stop"; exit 1; }
git rev-parse -q --verify backup/history-2026-11-26 >/dev/null || git branch backup/history-2026-11-26 main
git checkout -q --orphan clean-main
git add -A
export GIT_AUTHOR_NAME=PixCart-Dev GIT_AUTHOR_EMAIL=dev@pixcart.local GIT_COMMITTER_NAME=PixCart-Dev GIT_COMMITTER_EMAIL=dev@pixcart.local
git -c user.name=PixCart-Dev -c user.email=dev@pixcart.local commit -q -m "$subject" -m "$body"
git branch -M clean-main main
git log --format='%h %an <%ae> | %s%n%b' -1
if git log -1 --format=%B | grep -qiE "co-authored|claude|generated with|python|reference|port(ed|ing)"; then
  echo "commit message has a forbidden word: stop"; exit 1
fi
git push --force-with-lease=main:"$expect" origin main
git log --oneline origin/main -3
