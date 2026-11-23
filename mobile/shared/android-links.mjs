// Shared by both apps' patch-android.mjs: makes payment and app links work inside the app.
//
// Inside the app the shop runs in a WebView, which cannot open UPI apps by itself. Razorpay's checkout opens Google Pay,
// PhonePe, Paytm, BHIM and the rest through upi://, tez://, phonepe://, paytmmp:// and intent:// links. This replaces the
// generated MainActivity so that:
//  - every non-web link (upi://, intent://, tel:, mailto:, whatsapp:// ...) opens the app that handles it, started from
//    this screen, so when the shopper finishes paying, Android brings them straight back to the app, where the checkout
//    picks up the result;
//  - intent:// links get their browser_fallback_url or the app's Play Store page when the app is not installed;
//  - if nothing can open a UPI link, the shopper is told to install a UPI app or pay another way;
//  - web pages inside the payment window (bank and card security pages) stay inside the app.
// The manifest also lists the UPI apps (package visibility, Android 11 and later), so Android can find them.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARK = "PIXCART_LINKS";

const UPI_PACKAGES = [
  "com.google.android.apps.nbu.paisa.user", // Google Pay
  "com.phonepe.app",
  "net.one97.paytm",
  "in.org.npci.upiapp", // BHIM
  "in.amazon.mShop.android.shopping",
  "com.dreamplug.androidapp", // CRED
  "com.mobikwik_new",
  "com.whatsapp",
  "com.csam.icici.bank.imobile",
  "com.sbi.upi",
  "com.axis.mobile",
  "com.snapwork.hdfc",
  "com.myairtelapp",
  "com.naviapp",
  "money.super.payments",
];

export const QUERIES = `    <queries>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="upi" android:host="pay" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="upi" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="tez" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="phonepe" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="paytmmp" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="credpay" />
        </intent>
        <intent>
            <action android:name="android.intent.action.DIAL" />
        </intent>
${UPI_PACKAGES.map((p) => `        <package android:name="${p}" />`).join("\n")}
    </queries>`;

/** Adds the <queries> block (once). */
export function withQueries(xml) {
  if (xml.includes('android:scheme="upi"')) return xml;
  return xml.replace(/\n?<\/manifest>\s*$/, `\n${QUERIES}\n</manifest>\n`);
}

function findMainActivity(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const hit = findMainActivity(p);
      if (hit) return hit;
    } else if (name === "MainActivity.java") return p;
  }
  return null;
}

const java = (pkg) => `package ${pkg};

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

// ${MARK}: UPI apps and other app links open from here and come back here (written by mobile/shared/android-links.mjs).
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase();
                boolean web = scheme.equals("http") || scheme.equals("https");
                if (web && !request.isForMainFrame()) return false; // pages inside the payment window stay in the app
                if (web || scheme.equals("data") || scheme.equals("blob") || scheme.equals("about") || scheme.equals("javascript")) {
                    return super.shouldOverrideUrlLoading(view, request);
                }
                openOutside(url.toString(), scheme);
                return true;
            }
        });
    }

    private void openOutside(String link, String scheme) {
        Intent intent = null;
        try {
            if (scheme.equals("intent")) {
                intent = Intent.parseUri(link, Intent.URI_INTENT_SCHEME);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.setComponent(null);
                intent.setSelector(null);
            } else {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(link));
            }
            startActivity(intent);
            return;
        } catch (ActivityNotFoundException e) {
            // handled below
        } catch (Exception e) {
            intent = null;
        }
        if (intent != null && scheme.equals("intent")) {
            String fallback = intent.getStringExtra("browser_fallback_url");
            if (fallback != null && (fallback.startsWith("https://") || fallback.startsWith("http://"))) {
                if (tryOpen(new Intent(Intent.ACTION_VIEW, Uri.parse(fallback)))) return;
            }
            String pkg = intent.getPackage();
            if (pkg != null && !pkg.isEmpty()) {
                if (tryOpen(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg)))) return;
                if (tryOpen(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + pkg)))) return;
            }
        }
        boolean payment = link.contains("upi") || link.contains("pay?") || scheme.equals("tez") || scheme.equals("phonepe")
            || scheme.equals("paytmmp") || scheme.equals("credpay") || scheme.equals("bhim");
        Toast.makeText(this, payment
            ? "That UPI app is not installed on this phone. Choose another UPI app, or pay by card or net banking."
            : "No app on this phone can open this link.", Toast.LENGTH_LONG).show();
    }

    private boolean tryOpen(Intent intent) {
        try {
            startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
`;

/** Replaces the generated MainActivity (keeps its package name). */
export function writeMainActivity(root) {
  const base = join(root, "android/app/src/main/java");
  if (!existsSync(base)) throw new Error('android/app/src/main/java not found. Run "npx cap add android" first.');
  const file = findMainActivity(base);
  if (!file) throw new Error("MainActivity.java not found");
  const before = readFileSync(file, "utf8");
  const pkg = (before.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1];
  if (!pkg) throw new Error("MainActivity.java has no package line");
  const after = java(pkg);
  if (after !== before) writeFileSync(file, after);
  console.log(`${after === before ? "unchanged" : "patched  "} ${file.slice(root.length)} (UPI and app links)`);
}
