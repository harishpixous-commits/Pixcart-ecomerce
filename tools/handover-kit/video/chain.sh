#!/usr/bin/env bash
V="C:/Users/haris/AppData/Local/Temp/claude/f851d36ff915fc28/5d807180-5a2e-48ce-a7a2-25ea285aa60d/scratchpad/video"
B="/c/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/backend"
reset() { (cd "$B" && DATABASE_URL="postgresql+asyncpg://postgres:postgres@localhost:5433/pixcart_demo" ADMIN_PW="Pixcart@Demod9a39b" .venv/Scripts/python.exe "$V/reset.py" > "$V/reset.log" 2>&1); }
rm -f "$V/all.done"
for job in "$@"; do
  case "$job" in
    journey-web) reset; "$V/run.sh" journey.cjs "$V/rec" web ;;
    journey-mobile) reset; "$V/run.sh" journey.cjs "$V/rec" mobile ;;
    seller) reset; "$V/run.sh" seller.cjs "$V/rec" ;;
    admin) "$V/run.sh" admin.cjs "$V/rec" ;;
    delivery) reset; "$V/run.sh" delivery.cjs "$V/rec" ;;
  esac
done
echo done > "$V/all.done"
