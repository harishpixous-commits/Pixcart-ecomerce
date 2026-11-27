using Model.DomainModel.Integrations;

namespace Model.Constants;

/// <summary>
/// What can be connected in Admin → Integrations and how each provider's fields map onto runtime settings (the reference
/// version's integrations/registry.py). Every field names the settings attribute it overrides (snake_case, e.g.
/// "razorpay_key_id" = AppSettings.RazorpayKeyId). A value saved in the admin panel wins over appsettings; secrets are stored
/// encrypted and never sent back to the browser. On and Off say which settings the provider's switch forces.
/// </summary>
public static class IntegrationRegistry
{
    public static readonly IReadOnlyList<ProviderDef> Providers =
    [
        new ProviderDef
        {
            Key = "razorpay", Name = "Razorpay payments", Group = "payments",
            Purpose = "Cards, UPI, net banking and wallets at checkout; refunds go back through Razorpay.",
            NeededForLaunch = true,
            Fields =
            [
                new FieldDef { Key = "key_id", Label = "Key ID", Setting = "razorpay_key_id", Required = true, Pattern = "rzp_(test|live)_[A-Za-z0-9]{8,32}", PatternHint = "Starts with rzp_test_ or rzp_live_", Help = "Razorpay Dashboard → Account & Settings → API keys. Use test keys on staging.", Placeholder = "rzp_test_…" },
                new FieldDef { Key = "key_secret", Label = "Key secret", Setting = "razorpay_key_secret", Kind = "secret", Required = true, Help = "Shown once when you generate the key. Regenerating it also changes RazorpayX." },
                new FieldDef { Key = "webhook_secret", Label = "Webhook secret", Setting = "razorpay_webhook_secret", Kind = "secret", Required = true, Help = "Any long random text. Paste the same text in the Razorpay webhook form." },
            ],
            On = new Dictionary<string, object> { ["razorpay_checkout"] = true },
            Off = new Dictionary<string, object> { ["razorpay_checkout"] = false },
            DefaultOn = "razorpay_key_id",
            WebhookPath = "/api/payments/razorpay/webhook",
            WebhookEvents = ["payment.captured", "payment.failed", "order.paid", "refund.processed", "refund.failed"],
            DocsUrl = "https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/",
            SetupSteps =
            [
                "Sign up at dashboard.razorpay.com and finish KYC (test mode works before KYC).",
                "Account & Settings → API keys → Generate key. Copy the Key ID and Key secret here.",
                "Account & Settings → Webhooks → Add new webhook: paste the webhook URL shown here, type a secret, tick the events listed, save.",
                "Paste the same webhook secret here, save, then press Test connection.",
                "Place a test order with card 4111 1111 1111 1111 (any future expiry, any CVV) or UPI success@razorpay.",
            ],
        },
        new ProviderDef
        {
            Key = "cashfree", Name = "Cashfree payments", Group = "payments",
            Purpose = "Cards, UPI and net banking through Cashfree. Used by the routing order on Admin → Payments.",
            Fields =
            [
                new FieldDef { Key = "client_id", Label = "Client ID (App ID)", Setting = "cashfree_client_id", Required = true, Pattern = "[A-Za-z0-9_]{8,80}", PatternHint = "From the Cashfree dashboard. Test IDs start with TEST", Help = "Cashfree dashboard → Developers → API keys." },
                new FieldDef { Key = "client_secret", Label = "Client secret", Setting = "cashfree_client_secret", Kind = "secret", Required = true, Help = "Shown with the Client ID. Test and live keys differ." },
            ],
            On = new Dictionary<string, object> { ["cashfree_checkout"] = true },
            Off = new Dictionary<string, object> { ["cashfree_checkout"] = false },
            DefaultOn = "cashfree_client_id",
            WebhookPath = "/api/payments/cashfree/webhook",
            WebhookEvents = ["PAYMENT_SUCCESS_WEBHOOK", "PAYMENT_FAILED_WEBHOOK", "REFUND_STATUS_WEBHOOK"],
            DocsUrl = "https://www.cashfree.com/docs/payments/online/introduction",
            SetupSteps =
            [
                "Create a Cashfree account (test mode works first).",
                "Developers → API keys: copy the Client ID and Client secret here.",
                "Developers → Webhooks: paste the webhook URL shown here and tick the payment events.",
                "Save here, then press Test connection.",
            ],
        },
        new ProviderDef
        {
            Key = "phonepe", Name = "PhonePe payments", Group = "payments",
            Purpose = "UPI and cards through PhonePe Payment Gateway (redirect checkout).",
            Fields =
            [
                new FieldDef { Key = "client_id", Label = "Client ID", Setting = "phonepe_client_id", Required = true, Help = "PhonePe business dashboard → Developer settings." },
                new FieldDef { Key = "client_secret", Label = "Client secret", Setting = "phonepe_client_secret", Kind = "secret", Required = true },
                new FieldDef { Key = "client_version", Label = "Client version", Setting = "phonepe_client_version", Required = true, Pattern = "[0-9]{1,4}", PatternHint = "A number such as 1" },
                new FieldDef { Key = "webhook_username", Label = "Webhook username", Setting = "phonepe_webhook_username", Help = "Set the same username on the PhonePe webhook." },
                new FieldDef { Key = "webhook_password", Label = "Webhook password", Setting = "phonepe_webhook_password", Kind = "secret" },
                new FieldDef { Key = "mode", Label = "Environment", Setting = "phonepe_mode", Kind = "select", Options = ["sandbox", "live"], Help = "Sandbox moves no money." },
            ],
            On = new Dictionary<string, object> { ["phonepe_checkout"] = true },
            Off = new Dictionary<string, object> { ["phonepe_checkout"] = false },
            DefaultOn = "phonepe_client_id",
            WebhookPath = "/api/payments/phonepe/webhook",
            WebhookEvents = ["checkout.order.completed", "checkout.order.failed"],
            DocsUrl = "https://developer.phonepe.com/payment-gateway",
            SetupSteps =
            [
                "Get PhonePe Payment Gateway access and the client credentials.",
                "Paste the Client ID, secret and version here and pick sandbox first.",
                "On the PhonePe dashboard add the webhook URL shown here with the username and password you set here.",
                "Save here, then press Test connection.",
            ],
        },
        new ProviderDef
        {
            Key = "payu", Name = "PayU payments", Group = "payments",
            Purpose = "Cards, UPI and net banking through PayU hosted checkout.",
            Fields =
            [
                new FieldDef { Key = "key", Label = "Merchant key", Setting = "payu_key", Required = true, Pattern = "[A-Za-z0-9]{4,40}", PatternHint = "Letters and numbers" },
                new FieldDef { Key = "salt", Label = "Merchant salt", Setting = "payu_salt", Kind = "secret", Required = true },
                new FieldDef { Key = "mode", Label = "Environment", Setting = "payu_mode", Kind = "select", Options = ["sandbox", "live"], Help = "Sandbox uses test.payu.in and moves no money." },
            ],
            On = new Dictionary<string, object> { ["payu_checkout"] = true },
            Off = new Dictionary<string, object> { ["payu_checkout"] = false },
            DefaultOn = "payu_key",
            WebhookPath = "/api/payments/payu/webhook",
            WebhookEvents = ["success", "failure"],
            DocsUrl = "https://docs.payu.in/docs/generate-hash-merchant-hosted",
            SetupSteps =
            [
                "Open a PayU merchant account (test key and salt are available first).",
                "Paste the merchant key and salt here and pick sandbox first.",
                "In PayU dashboard → Webhooks add the webhook URL shown here.",
                "Save here, then press Test connection.",
            ],
        },
        new ProviderDef
        {
            Key = "stripe", Name = "Stripe payments", Group = "payments",
            Purpose = "Cards and international payments through Stripe Checkout (redirect).",
            Fields =
            [
                new FieldDef { Key = "secret_key", Label = "Secret key", Setting = "stripe_secret_key", Kind = "secret", Required = true, Help = "Stripe dashboard → Developers → API keys. Test keys start with sk_test_." },
                new FieldDef { Key = "webhook_secret", Label = "Webhook signing secret", Setting = "stripe_webhook_secret", Kind = "secret", Required = true, Help = "Shown after you add the webhook endpoint (starts with whsec_)." },
            ],
            On = new Dictionary<string, object> { ["stripe_checkout"] = true },
            Off = new Dictionary<string, object> { ["stripe_checkout"] = false },
            DefaultOn = "stripe_secret_key",
            WebhookPath = "/api/payments/stripe/webhook",
            WebhookEvents = ["checkout.session.completed", "checkout.session.expired"],
            DocsUrl = "https://docs.stripe.com/payments/checkout",
            SetupSteps =
            [
                "Create a Stripe account and use test mode first.",
                "Developers → API keys: copy the secret key here.",
                "Developers → Webhooks → Add endpoint: paste the webhook URL shown here and tick the checkout.session events.",
                "Paste the signing secret here, save, then press Test connection.",
            ],
        },
        new ProviderDef
        {
            Key = "razorpayx", Name = "RazorpayX automatic payouts", Group = "payments",
            Purpose = "Sends seller payouts straight to their bank accounts. Without it, payouts use a bank file and you enter the UTR.",
            Fields =
            [
                new FieldDef { Key = "account_number", Label = "RazorpayX account number", Setting = "razorpayx_account_number", Required = true, Pattern = "[0-9]{10,20}", PatternHint = "10 to 20 digits", Help = "RazorpayX → Account & Settings → Banking. This is your RazorpayX account, not a seller's." },
                new FieldDef { Key = "webhook_secret", Label = "Webhook secret", Setting = "razorpayx_webhook_secret", Kind = "secret", Required = true, Help = "Set the same secret on the RazorpayX webhook." },
            ],
            On = new Dictionary<string, object> { ["payout_mode"] = "razorpayx" },
            Off = new Dictionary<string, object> { ["payout_mode"] = "manual" },
            DefaultOn = "payout_mode==razorpayx",
            WebhookPath = "/api/webhooks/razorpayx",
            WebhookEvents = ["payout.processed", "payout.failed", "payout.reversed", "payout.rejected"],
            DocsUrl = "https://razorpay.com/docs/x/payouts/best-practices/",
            SetupSteps =
            [
                "Open a RazorpayX current account (x.razorpay.com). It uses the same API keys as Razorpay payments.",
                "Allowlist the server's outbound IP in RazorpayX → Developer controls (the NAT gateway IP from Terraform output).",
                "Copy your RazorpayX account number here.",
                "Add a webhook with the URL shown here and the payout events listed, then paste its secret here.",
                "Switch on. New payouts are sent with an idempotency key, so a retry never pays twice.",
            ],
        },
        new ProviderDef
        {
            Key = "msg91", Name = "MSG91 SMS", Group = "messaging",
            Purpose = "Sends login OTPs and order SMS. Until it is on, OTPs only appear in the server log (development).",
            NeededForLaunch = true,
            Fields =
            [
                new FieldDef { Key = "auth_key", Label = "Auth key", Setting = "msg91_auth_key", Kind = "secret", Required = true, Help = "MSG91 → API → Auth key." },
                new FieldDef { Key = "otp_template_id", Label = "OTP template ID", Setting = "msg91_otp_template_id", Required = true, Pattern = "[A-Za-z0-9]{8,40}", PatternHint = "Letters and digits", Help = "MSG91 → OTP → template. The text must match your DLT-approved OTP template." },
                new FieldDef { Key = "sender_id", Label = "Sender ID (DLT header)", Setting = "msg91_sender_id", Pattern = "[A-Z]{6}", PatternHint = "6 capital letters", Placeholder = "PIXCRT" },
                new FieldDef { Key = "dlt_entity_id", Label = "DLT entity ID", Setting = "msg91_dlt_entity_id", Pattern = "[0-9]{10,25}", PatternHint = "Digits from your DLT portal", Help = "For your records and support tickets; templates are linked to it on the DLT portal." },
            ],
            On = new Dictionary<string, object> { ["sms_provider"] = "msg91" },
            Off = new Dictionary<string, object> { ["sms_provider"] = "console" },
            DefaultOn = "sms_provider==msg91",
            DocsUrl = "https://docs.msg91.com/",
            SetupSteps =
            [
                "Register your business and the sender ID on a DLT portal (Jio, Vodafone Idea, Airtel or BSNL). Approval takes 2–7 days.",
                "Register the OTP template and each order-SMS template on DLT, then add them in MSG91 with the DLT template IDs.",
                "Copy the MSG91 auth key and the OTP template ID here and switch on.",
                "Use Test connection with your own mobile number: you should get an SMS within a minute.",
            ],
        },
        new ProviderDef
        {
            Key = "email", Name = "Email (Amazon SES or any SMTP)", Group = "messaging",
            Purpose = "Order, seller and support emails.",
            NeededForLaunch = true,
            Fields =
            [
                new FieldDef { Key = "host", Label = "SMTP host", Setting = "smtp_host", Required = true, Pattern = "[A-Za-z0-9.-]{3,253}", PatternHint = "A host name", Placeholder = "email-smtp.ap-south-1.amazonaws.com" },
                new FieldDef { Key = "port", Label = "Port", Setting = "smtp_port", Kind = "number", Placeholder = "587", Min = 1.0, Max = 65535.0 },
                new FieldDef { Key = "security", Label = "Connection security", Setting = "smtp_security", Kind = "select", Options = ["starttls", "ssl", "none"] },
                new FieldDef { Key = "user", Label = "SMTP user", Setting = "smtp_user", Help = "SES → SMTP settings → Create SMTP credentials." },
                new FieldDef { Key = "password", Label = "SMTP password", Setting = "smtp_password", Kind = "secret" },
                new FieldDef { Key = "from_address", Label = "Sender address", Setting = "smtp_from", Kind = "email", Required = true, Help = "Must be on a domain verified in SES. The display name is your brand name.", Placeholder = "orders@yourdomain.in" },
            ],
            Off = new Dictionary<string, object> { ["smtp_host"] = "" },
            DefaultOn = "smtp_host",
            DocsUrl = "https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html",
            SetupSteps =
            [
                "In Amazon SES (ap-south-1), verify your domain: add the DKIM CNAME records it gives you in Route 53.",
                "Request production access in SES so you can email any address (sandbox only reaches verified addresses).",
                "SES → SMTP settings → Create SMTP credentials. Copy the user and password here.",
                "Enter a sender address on the verified domain, save, and send a test email to yourself.",
            ],
        },
        new ProviderDef
        {
            Key = "whatsapp", Name = "WhatsApp Cloud API", Group = "messaging",
            Purpose = "Order updates on WhatsApp using approved message templates.",
            Fields =
            [
                new FieldDef { Key = "phone_number_id", Label = "Phone number ID", Setting = "whatsapp_phone_number_id", Required = true, Pattern = "[0-9]{6,25}", PatternHint = "Digits" },
                new FieldDef { Key = "token", Label = "Permanent access token", Setting = "whatsapp_token", Kind = "secret", Required = true, Help = "Meta Business → System users → Generate token with whatsapp_business_messaging." },
                new FieldDef { Key = "language", Label = "Template language code", Setting = "whatsapp_language", Pattern = "[a-z]{2}(_[A-Z]{2})?", PatternHint = "e.g. en or en_US", Placeholder = "en" },
                new FieldDef { Key = "api_version", Label = "Graph API version", Setting = "whatsapp_api_version", Pattern = "v[0-9]{2}\\.[0-9]", PatternHint = "e.g. v21.0", Placeholder = "v21.0" },
            ],
            Off = new Dictionary<string, object> { ["whatsapp_token"] = "" },
            DefaultOn = "whatsapp_token",
            DocsUrl = "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
            SetupSteps =
            [
                "Create a Meta Business account and a WhatsApp Business app at developers.facebook.com.",
                "Add and verify your business phone number; copy its Phone number ID here.",
                "Create a system user, give it the app, and generate a permanent token with whatsapp_business_messaging.",
                "Create message templates in WhatsApp Manager and enter their names in Admin → Notifications.",
            ],
        },
        new ProviderDef
        {
            Key = "firebase", Name = "Firebase push notifications", Group = "messaging",
            Purpose = "Instant push notifications on phones and browsers: new delivery requests for partners even when the app is in the background, order and delivery updates for shoppers, alerts for staff. Without it, these appear inside the app only.",
            Fields =
            [
                new FieldDef { Key = "project_id", Label = "Project ID", Setting = "firebase_project_id", Required = true, Pattern = "[a-z0-9-]{4,40}", PatternHint = "Lowercase letters, digits and hyphens", Help = "Firebase console → Project settings → General → Project ID." },
                new FieldDef { Key = "client_email", Label = "Service account email", Setting = "firebase_client_email", Kind = "email", Required = true, Help = "Project settings → Service accounts → Generate new private key. Copy client_email from the downloaded JSON file." },
                new FieldDef { Key = "private_key", Label = "Service account private key", Setting = "firebase_private_key", Kind = "secret", Required = true, Help = "The private_key value from the same JSON file, copied as it is (one line with \\n in it).", MaxLen = 4000 },
                new FieldDef { Key = "api_key", Label = "Web API key", Setting = "firebase_api_key", Required = true, Pattern = "[A-Za-z0-9_-]{20,60}", PatternHint = "From the web app config", Help = "Project settings → General → Your apps → add a Web app → apiKey." },
                new FieldDef { Key = "sender_id", Label = "Sender ID", Setting = "firebase_sender_id", Required = true, Pattern = "[0-9]{6,20}", PatternHint = "Digits (messagingSenderId)" },
                new FieldDef { Key = "app_id", Label = "Web app ID", Setting = "firebase_app_id", Required = true, Pattern = "[0-9]+:[0-9]+:web:[A-Za-z0-9]+", PatternHint = "Looks like 1:1234:web:abcd" },
                new FieldDef { Key = "vapid_key", Label = "Web push certificate key", Setting = "firebase_vapid_key", Required = true, Pattern = "[A-Za-z0-9_-]{60,120}", PatternHint = "Project settings → Cloud Messaging → Web Push certificates → Key pair" },
            ],
            Off = new Dictionary<string, object> { ["firebase_project_id"] = "" },
            DefaultOn = "firebase_project_id",
            DocsUrl = "https://firebase.google.com/docs/cloud-messaging",
            SetupSteps =
            [
                "Create a project at console.firebase.google.com (Google Analytics is not needed).",
                "Project settings → General → Your apps → Add app → Web. Copy apiKey, messagingSenderId and appId here.",
                "Project settings → Cloud Messaging → Web Push certificates → Generate key pair. Copy the key here.",
                "Project settings → Service accounts → Generate new private key. From the JSON file copy client_email and private_key here.",
                "For the Android partner app: add an Android app with the app's package name and put google-services.json in the app project before building.",
                "Save, switch on and press Test connection. Partners then tap Allow notifications in the partner app.",
            ],
        },
        new ProviderDef
        {
            Key = "shiprocket", Name = "Shiprocket", Group = "shipping",
            Purpose = "Books couriers, prints labels and updates tracking automatically.",
            Fields =
            [
                new FieldDef { Key = "email", Label = "API user email", Setting = "shiprocket_email", Kind = "email", Required = true, Help = "Shiprocket → Settings → API → Create an API user (a separate login just for the API)." },
                new FieldDef { Key = "password", Label = "API user password", Setting = "shiprocket_password", Kind = "secret", Required = true },
                new FieldDef { Key = "webhook_token", Label = "Webhook token", Setting = "shiprocket_webhook_token", Kind = "secret", Required = true, Help = "Any long random text. Shiprocket sends it in the x-api-key header." },
            ],
            On = new Dictionary<string, object> { ["shipping_provider"] = "shiprocket" },
            Off = new Dictionary<string, object> { ["shipping_provider"] = "manual" },
            DefaultOn = "shipping_provider==shiprocket",
            WebhookPath = "/api/webhooks/shiprocket",
            WebhookEvents = ["Tracking updates"],
            DocsUrl = "https://apidocs.shiprocket.in/",
            SetupSteps =
            [
                "Shiprocket → Settings → API → Configure → create an API user. Copy its email and password here.",
                "Settings → API → Webhooks: paste the webhook URL shown here and the same token, then save.",
                "Each seller warehouse becomes a Shiprocket pickup location the first time an order ships from it.",
            ],
        },
        new ProviderDef
        {
            Key = "ai", Name = "AI provider (Claude by Anthropic)", Group = "ai",
            Purpose = "Powers the admin AI assistant and AI studio drafts. Without a key the AI features run in sandbox mode.",
            Fields =
            [
                new FieldDef { Key = "provider", Label = "Provider", Setting = "ai_provider", Kind = "select", Options = ["anthropic"], Help = "Claude through the Anthropic API. The model and monthly budget are set in AI studio." },
                new FieldDef { Key = "api_key", Label = "API key", Setting = "anthropic_api_key", Kind = "secret", Required = true, Help = "console.anthropic.com → API keys. Set a monthly spend limit there too." },
                new FieldDef { Key = "api_base", Label = "API address", Setting = "anthropic_api_base", Kind = "url", Pattern = "https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?", PatternHint = "An https address", Help = "Leave as is unless you route through a company proxy.", Placeholder = "https://api.anthropic.com" },
            ],
            Off = new Dictionary<string, object> { ["anthropic_api_key"] = "" },
            DefaultOn = "anthropic_api_key",
            DocsUrl = "https://docs.claude.com/en/api/overview",
            SetupSteps =
            [
                "Create an organisation at console.anthropic.com and add billing.",
                "Settings → Limits: set a monthly spend limit you are comfortable with.",
                "API keys → Create key (one key per environment). Paste it here, save and press Test connection.",
                "Choose the model and the monthly token budget in Admin → AI studio.",
            ],
        },
        new ProviderDef
        {
            Key = "sentry", Name = "Sentry error tracking", Group = "monitoring",
            Purpose = "Reports server errors with stack traces. No personal data is sent.",
            Fields =
            [
                new FieldDef { Key = "dsn", Label = "DSN", Setting = "sentry_dsn", Kind = "secret", Required = true, Pattern = "https://[A-Za-z0-9]+@[A-Za-z0-9.-]+(:[0-9]+)?/[0-9]+", PatternHint = "https://key@o123.ingest.sentry.io/456" },
                new FieldDef { Key = "traces_sample_rate", Label = "Performance sample rate", Setting = "sentry_traces_sample_rate", Kind = "number", Placeholder = "0.05", Min = 0.0, Max = 1.0 },
            ],
            Off = new Dictionary<string, object> { ["sentry_dsn"] = "" },
            DefaultOn = "sentry_dsn",
            DocsUrl = "https://docs.sentry.io/platforms/dotnet/guides/aspnetcore/",
            SetupSteps =
            [
                "Create an ASP.NET Core project in Sentry and copy its DSN here.",
                "Save; the server starts reporting within a minute.",
            ],
        },
    ];

    public static readonly IReadOnlyDictionary<string, ProviderDef> ByKey = Providers.ToDictionary(p => p.Key);

    public static readonly IReadOnlyDictionary<string, string> GroupLabels = new Dictionary<string, string>
    {
        ["payments"] = "Payments and payouts",
        ["messaging"] = "SMS, email, WhatsApp and push notifications",
        ["shipping"] = "Shipping",
        ["ai"] = "AI",
        ["monitoring"] = "Monitoring",
    };
}
