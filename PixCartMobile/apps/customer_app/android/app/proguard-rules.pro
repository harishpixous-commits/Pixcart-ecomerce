# Razorpay checkout (Razorpay Android standard integration, ProGuard rules)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
-keepattributes *Annotation*
-dontwarn com.razorpay.**
-keep class com.razorpay.** {*;}
-optimizations !method/inlining/*
-keepclasseswithmembers class * {
    public void onPayment*(...);
}
# Google Pay in-app UPI classes that Razorpay looks up by reflection
-dontwarn com.google.android.apps.nbu.paisa.inapp.client.api.**
-keep class com.google.android.apps.nbu.paisa.inapp.client.api.** {*;}
# Play Core (deferred components) referenced by the Flutter engine
-dontwarn com.google.android.play.core.**
