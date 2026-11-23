// Prepares the generated Android project (run after `npx cap add android` and `npx cap sync android`):
//  - location permissions, so the partner's position can be shared while online and on a trip
//  - version name and build number from APP_VERSION and APP_BUILD
//  - the live site address in the offline page's "Try again" button
// Safe to run more than once.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withQueries, writeMainActivity } from "../../shared/android-links.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = (process.env.PIXCART_WEB_URL || "https://pixcart.in").replace(/\/+$/, "");
const version = (process.env.APP_VERSION || "1.0.0").trim();
const build = Number.parseInt(process.env.APP_BUILD || "1", 10) || 1;

function patch(file, fn) {
  const path = join(root, file);
  if (!existsSync(path)) throw new Error(`${file} not found. Run "npx cap add android" first.`);
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after !== before) writeFileSync(path, after);
  console.log(`${after === before ? "unchanged" : "patched  "} ${file}`);
}

patch("android/app/src/main/AndroidManifest.xml", (xml) => {
  const wanted = [
    '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
    '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
    '<uses-feature android:name="android.hardware.location.gps" android:required="false" />',
  ].filter((line) => !xml.includes(line.match(/android:name="([^"]+)"/)[1]));
  return withQueries(wanted.length ? xml.replace("</manifest>", `    ${wanted.join("\n    ")}\n</manifest>`) : xml);
});

patch("android/app/build.gradle", (gradle) =>
  gradle
    .replace(/versionCode\s+\d+/, `versionCode ${build}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${version.replace(/"/g, "")}"`),
);

// the copy inside the app (sync copies www/ there), so the source file keeps its placeholder
patch("android/app/src/main/assets/public/index.html", (html) => html.replace(/data-url="[^"]*"/, `data-url="${web}/delivery"`));

// UPI apps (Google Pay, PhonePe, Paytm, BHIM...) and other app links open from the app and return to it
writeMainActivity(root);
