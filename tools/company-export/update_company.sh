#!/usr/bin/env bash
# Ship the integration branch to a company repository as a normal commit (no history rewrite).
#   bash update_company.sh web|mobile "Commit subject" ["Commit body"]
# Steps: clean export -> build and tests on the exported tree -> neutral commit (no trailers) -> push.
# Stops at the first failure; nothing is pushed unless every check passed.
set -euo pipefail
which="$1"; subject="$2"; body="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="/c/Users/haris/pixcart-tools/node-v22.23.5-win-x64:/c/Users/haris/pixcart-tools/flutter/bin:$PATH"
case "$which" in
  web) dir=/c/Users/haris/Downloads/Pix-ShopCart_Web ;;
  mobile) dir=/c/Users/haris/Downloads/Pix-ShopCart_Mobile ;;
  *) echo "web or mobile"; exit 2 ;;
esac
if printf '%s\n%s' "$subject" "$body" | grep -qiE "co-authored|claude|generated with|python|reference|port(ed|ing)|migrat"; then
  echo "commit message has a forbidden word: stop"; exit 1
fi
cd "$dir"
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "local main is not origin/main: stop"; exit 1; }
python -I -X utf8 "$HERE/export_company.py" "$which"
if [ "$which" = web ]; then
  [ -e PixCartWeb/node_modules ] || cmd //c mklink /J "PixCartWeb\\node_modules" "C:\\Users\\haris\\Downloads\\PixCart-company\\PixCartWeb\\node_modules"
  (cd PixCartAPI && dotnet build PixCartAPI.sln -nologo -v q && dotnet test Tests/Tests.csproj --no-build -nologo)
  (cd PixCartWeb && npx ng build --configuration production && npm run test:shop-contracts)
else
  flutter pub get
  flutter analyze
  for d in packages/pixcart_core apps/customer_app apps/partner_app apps/seller_app; do (cd "$d" && flutter test); done
fi
git add -A
if git diff --cached --quiet; then echo "nothing to ship"; exit 0; fi
if git diff --cached --name-only | grep -qE "(^|/)(node_modules|dist|out-tsc|\.angular|bin|obj|\.dart_tool|build)/"; then
  echo "build output staged: stop"; exit 1
fi
git -c user.name=PixCart-Dev -c user.email=dev@pixcart.local commit -q -m "$subject" ${body:+-m "$body"}
git push origin main
git log --oneline -3 origin/main
