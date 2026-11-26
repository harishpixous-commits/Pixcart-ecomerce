#!/usr/bin/env bash
# Records the five demo videos of the Angular + .NET version with the SAME scripts that recorded the Python version.
#   chain_net.sh journey-web journey-mobile seller admin delivery
# Env: BASE (the site with /api, default http://localhost:5180 = the IIS package served by the .NET API),
#      NEW_PARTNER (a phone with no partner account yet, for the delivery video's sign-up).
V="$(cd "$(dirname "$0")" && pwd)"
OUT="$V/rec-net"
mkdir -p "$OUT"
export BASE="${BASE:-http://localhost:5180}"
export NEW_PARTNER="${NEW_PARTNER:-7300000009}"
export PATH="/c/Users/haris/pixcart-tools/node-v22.23.5-win-x64:$PATH"
export E2E_DIR="C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/e2e"
export CHROME_PATH="C:/Users/haris/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe"
export ADMIN_PW="$(cat /c/Users/haris/pixcart-tools/parity-admin-password.txt)"
export MEDIA_DIR="C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/backend/var/media-demo"
export DEMO_IMAGES="C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/backend/scripts/demo_images"
export MSYS_NO_PATHCONV=1
reset() { python -I "$V/reset_net.py" > "$OUT/reset.log" 2>&1; }
record() { name="$(basename "$1" .cjs)${3:+-$3}"; (cd "$V" && node "$@" > "$OUT/$name.log" 2>&1; echo "exit $?" >> "$OUT/$name.log"); }
rm -f "$OUT/all.done"
for job in "$@"; do
  case "$job" in
    journey-web) reset; record journey.cjs "$OUT" web ;;
    journey-mobile) reset; record journey.cjs "$OUT" mobile ;;
    seller) reset; record seller.cjs "$OUT" ;;
    admin) record admin.cjs "$OUT" ;;
    delivery) reset; record delivery.cjs "$OUT" ;;
  esac
done
echo done > "$OUT/all.done"
