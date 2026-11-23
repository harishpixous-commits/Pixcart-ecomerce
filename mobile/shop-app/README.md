# PixCart: customer Android app

The shopping app for Android. It is a native shell (Capacitor 8) around the live shop at `https://<your site>`, so
it looks and works exactly like the website (sign-in with mobile number, register, search, cart, checkout, orders,
returns, wishlist, help) and every website update reaches shoppers without a new APK. The shell adds:

- **Push notifications** through Firebase for order updates, even when the app is closed.
- **Camera** for review photos and returns, and **location** for "Use my location" when adding an address.
- An offline page with a "Try again" button.
- **UPI payments**: Razorpay shows Google Pay, PhonePe, Paytm, BHIM and the other UPI apps on the phone. Tapping one opens
  that app, and after paying Android returns to PixCart, where the order shows "Payment received" (or "Payment not
  received" with Try again). `scripts/patch-android.mjs` sets this up (`mobile/shared/android-links.mjs`).

iPhone and iPad: shoppers install the same app from Safari (**Share → Add to Home Screen**), guided on
`https://<your site>/app`. A listing on the App Store needs an Apple Developer account and a Mac with Xcode
(`npx cap add ios`, then build and submit from Xcode); add the App Store link in Admin → Marketplace settings →
Mobile apps when it is live.

## Build it (no Android Studio needed)

1. In GitHub open **Actions → Android shop app → Run workflow**.
2. Enter your live website (for example `https://pixcart.in`) and a version (for example `1.0.0`).
3. When the run finishes, download `pixcart-shop.apk` from the run's artifacts or from **Releases**.
4. In the admin panel open **Marketplace settings → Mobile apps**, upload the APK with its version, and save.
   Shoppers download it from `https://<your site>/app` (also offered by the "Get the app" bar on phones).

### Secrets (Settings → Secrets and variables → Actions)

| Secret | What it is | Without it |
| --- | --- | --- |
| `GOOGLE_SERVICES_JSON` | `google-services.json` from Firebase (add an Android app with the package name `in.pixcart.shop`), base64 encoded | The app works, without push notifications |
| `ANDROID_KEYSTORE_BASE64` | Your release keystore (`.jks`), base64 encoded | The APK is debug-signed: fine for testing, not for shoppers |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password | |
| `ANDROID_KEY_ALIAS` | Key alias | |
| `ANDROID_KEY_PASSWORD` | Key password | |

Make a keystore once and keep it safe (Android only installs an update signed with the same key):

```sh
keytool -genkeypair -v -keystore pixcart-shop.jks -alias shop -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 pixcart-shop.jks   # paste the output into ANDROID_KEYSTORE_BASE64
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
store's app icon at `/app-icon/maskable`); replace them to change the look.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `PIXCART_WEB_URL` | `https://pixcart.in` | Your site; the app opens the shop |
| `PIXCART_APP_ID` | `in.pixcart.shop` | Android package name. Change it only before the first release |
| `PIXCART_APP_NAME` | `PixCart` | Name under the icon |
| `APP_VERSION`, `APP_BUILD` | `1.0.0`, `1` | Version name and build number (the workflow uses its run number) |
