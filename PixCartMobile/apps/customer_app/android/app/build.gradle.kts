import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Values given with --dart-define reach Gradle base64-encoded in the "dart-defines" property:
// APP_NAME sets the name under the icon, SITE_HOST the website whose links open in the app.
val dartDefines: Map<String, String> = (project.findProperty("dart-defines") as String? ?: "")
    .split(",")
    .filter { it.isNotBlank() }
    .map { String(Base64.getDecoder().decode(it)) }
    .filter { it.contains("=") }
    .associate { it.substringBefore("=") to it.substringAfter("=") }

// Release signing: android/key.properties (not committed) or the environment variables of the CI.
val keyProps = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signing(name: String, env: String): String? = keyProps.getProperty(name) ?: System.getenv(env)

android {
    namespace = "in.pixcart.shop"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "in.pixcart.shop"
        minSdk = maxOf(flutter.minSdkVersion, 23)
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["appName"] = dartDefines["APP_NAME"] ?: "PixCart"
        manifestPlaceholders["siteHost"] = dartDefines["SITE_HOST"] ?: "pixcart.in"
    }

    signingConfigs {
        create("release") {
            val store = signing("storeFile", "ANDROID_KEYSTORE_PATH")
            if (store != null) {
                storeFile = file(store)
                storePassword = signing("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signing("keyAlias", "ANDROID_KEY_ALIAS")
                keyPassword = signing("keyPassword", "ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // Without a keystore the release build is signed with the debug key (fine for testing, not for the stores).
            signingConfig = if (signing("storeFile", "ANDROID_KEYSTORE_PATH") != null) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
