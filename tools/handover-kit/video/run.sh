#!/usr/bin/env bash
# usage: run.sh <script.cjs> [args...]  -> logs to <name>.log
V="C:/Users/haris/AppData/Local/Temp/claude/f851d36ff915fc28/5d807180-5a2e-48ce-a7a2-25ea285aa60d/scratchpad/video"
cd "$V"
export NEW_PARTNER="${NEW_PARTNER:-7300000003}" PATH="/c/Users/haris/pixcart-tools/node-v22.23.5-win-x64:$PATH" E2E_DIR="C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/e2e" CHROME_PATH="C:/Users/haris/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe" ADMIN_PW="Pixcart@Demod9a39b" MEDIA_DIR="C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/backend/var/media-demo" DEMO_IMAGES="C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/backend/scripts/demo_images"
name="$(basename "$1" .cjs)${3:+-$3}"
node "$@" > "$V/$name.log" 2>&1
echo "exit $?" >> "$V/$name.log"
