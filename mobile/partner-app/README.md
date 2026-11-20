# PixCart Partner: Android app

The delivery partner app for Android. It is a native shell (Capacitor 8) around the partner web app at
`https://<your site>/delivery`, so everything partners see and do (sign-up, documents, going online, delivery
requests, trips, earnings) comes from the website and updates without a new APK. The shell adds:

- **Push notifications** through Firebase, so a new delivery request rings the phone even when the app is closed
  (the web app registers the phone with `POST /api/push/tokens`, platform `android`).
- **Location** for sharing the partner's position while online or on a trip.
- **Camera** for the delivery photo (the web page's photo button opens the camera).
- An offline page with a "Try again" button.

## Build it (no Android Studio needed)

1. In GitHub open **Actions → Android partner app → Run workflow**.
2. Enter your live website (for example `https://pixcart.in`) and a version (for example `1.0.0`).
3. When the run finishes, download `pixcart-partner.apk` from the run's artifacts or from **Releases**.
4. In the admin panel open **Delivery → Settings → Partner Android app**, upload the APK with its version, and save.
   Partners download it from `https://<your site>/delivery/download` (also linked in the partner app).

### Secrets (Settings → Secrets and variables → Actions)

| Secret | What it is | Without it |
| --- | --- | --- |
| `GOOGLE_SERVICES_JSON` | `google-services.json` from Firebase (add an Android app with the package name `in.pixcart.partner`), base64 encoded | The app works, without push notifications |
| `ANDROID_KEYSTORE_BASE64` | Your release keystore (`.jks`), base64 encoded | The APK is debug-signed: fine for testing, not for partners |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password | |
| `ANDROID_KEY_ALIAS` | Key alias | |
| `ANDROID_KEY_PASSWORD` | Key password | |

Make a keystore once and keep it safe (Android only installs an update signed with the same key):

```sh
keytool -genkeypair -v -keystore pixcart-partner.jks -alias partner -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 pixcart-partner.jks   # paste the output into ANDROID_KEYSTORE_BASE64
base64 -w0 google-services.json  # paste the output into GOOGLE_SERVICES_JSON
```

The server side of push notifications is set up in **Admin → Integrations → Firebase** (service account and web keys).

## Build on your own computer

Needs Node 22+, JDK 21 and the Android SDK (Android Studio installs both).

```sh
npm ci
export PIXCART_WEB_URL=https://pixcart.in APP_VERSION=1.0.0 APP_BUILD=1
npx cap add android
npx @capacitor/assets@4.0.0 generate --android --iconBackgroundColor '#0B5563' --splashBackgroundColor '#EEF2F4' --splashBackgroundColorDark '#073B45'
npx cap sync android
node scripts/patch-android.mjs
cd android && ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

`android/` is generated on every build and not kept in git. The icon and splash come from `assets/` (made from the
store's app icon at `/app-icon/partner-512`); replace them to change the look.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `PIXCART_WEB_URL` | `https://pixcart.in` | Your site; the app opens `<site>/delivery` |
| `PIXCART_APP_ID` | `in.pixcart.partner` | Android package name. Change it only before the first release |
| `PIXCART_APP_NAME` | `PixCart Partner` | Name under the icon |
| `APP_VERSION`, `APP_BUILD` | `1.0.0`, `1` | Version name and build number (the workflow uses its run number) |
