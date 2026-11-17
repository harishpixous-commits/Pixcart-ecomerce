"""What can be connected, and how each provider's fields map onto runtime settings.

Every field names the ``Settings`` attribute it overrides. The server environment (AWS Secrets
Manager in production, ``.env`` locally) supplies the starting value; a value saved in
Admin → Integrations wins over it. Secrets are stored encrypted and never sent back to the browser.

Each provider also has an on/off switch. ``on`` and ``off`` say which settings the switch forces,
so the rest of the code keeps reading plain settings (``settings.sms_provider == "msg91"``)
through ``app.integrations.store.get()``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

FieldKind = Literal["text", "secret", "email", "url", "number", "select", "bool"]


@dataclass(frozen=True)
class FieldDef:
    key: str
    label: str
    setting: str  # Settings attribute this field overrides
    kind: FieldKind = "text"
    required: bool = False
    pattern: str | None = None  # full-match regex for text values
    pattern_hint: str = ""
    options: tuple[str, ...] = ()
    help: str = ""
    placeholder: str = ""
    min: float | None = None
    max: float | None = None

    @property
    def secret(self) -> bool:
        return self.kind == "secret"


@dataclass(frozen=True)
class Provider:
    key: str
    name: str
    group: Literal["payments", "messaging", "shipping", "ai", "monitoring", "analytics"]
    purpose: str
    fields: tuple[FieldDef, ...]
    docs_url: str
    setup_steps: tuple[str, ...]
    needed_for_launch: bool = False
    on: dict[str, Any] = field(default_factory=dict)  # settings forced when switched on
    off: dict[str, Any] = field(default_factory=dict)  # settings forced when switched off
    default_on: str = ""  # Settings expression deciding the switch when admin never touched it
    webhook_path: str = ""
    webhook_events: tuple[str, ...] = ()
    testable: bool = True
    restart_note: str = ""

    def field(self, key: str) -> FieldDef:
        for f in self.fields:
            if f.key == key:
                return f
        raise KeyError(key)


PROVIDERS: tuple[Provider, ...] = (
    Provider(
        key="razorpay",
        name="Razorpay payments",
        group="payments",
        purpose="Cards, UPI, net banking and wallets at checkout; refunds go back through Razorpay.",
        needed_for_launch=True,
        fields=(
            FieldDef("key_id", "Key ID", "razorpay_key_id", required=True, pattern=r"rzp_(test|live)_[A-Za-z0-9]{8,32}",
                     pattern_hint="Starts with rzp_test_ or rzp_live_", placeholder="rzp_test_…",
                     help="Razorpay Dashboard → Account & Settings → API keys. Use test keys on staging."),
            FieldDef("key_secret", "Key secret", "razorpay_key_secret", kind="secret", required=True,
                     help="Shown once when you generate the key. Regenerating it also changes RazorpayX."),
            FieldDef("webhook_secret", "Webhook secret", "razorpay_webhook_secret", kind="secret", required=True,
                     help="Any long random text. Paste the same text in the Razorpay webhook form."),
        ),
        off={"razorpay_checkout": False},
        on={"razorpay_checkout": True},
        default_on="razorpay_key_id",
        webhook_path="/api/payments/razorpay/webhook",
        webhook_events=("payment.captured", "payment.failed", "order.paid", "refund.processed", "refund.failed"),
        docs_url="https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/",
        setup_steps=(
            "Sign up at dashboard.razorpay.com and finish KYC (test mode works before KYC).",
            "Account & Settings → API keys → Generate key. Copy the Key ID and Key secret here.",
            "Account & Settings → Webhooks → Add new webhook: paste the webhook URL shown here, type a secret, tick the events listed, save.",
            "Paste the same webhook secret here, save, then press Test connection.",
            "Place a test order with card 4111 1111 1111 1111 (any future expiry, any CVV) or UPI success@razorpay.",
        ),
    ),
    Provider(
        key="razorpayx",
        name="RazorpayX automatic payouts",
        group="payments",
        purpose="Sends seller payouts straight to their bank accounts. Without it, payouts use a bank file and you enter the UTR.",
        fields=(
            FieldDef("account_number", "RazorpayX account number", "razorpayx_account_number", required=True, pattern=r"[0-9]{10,20}",
                     pattern_hint="10 to 20 digits", help="RazorpayX → Account & Settings → Banking. This is your RazorpayX account, not a seller's."),
            FieldDef("webhook_secret", "Webhook secret", "razorpayx_webhook_secret", kind="secret", required=True,
                     help="Set the same secret on the RazorpayX webhook."),
        ),
        on={"payout_mode": "razorpayx"},
        off={"payout_mode": "manual"},
        default_on="payout_mode==razorpayx",
        webhook_path="/api/webhooks/razorpayx",
        webhook_events=("payout.processed", "payout.failed", "payout.reversed", "payout.rejected"),
        docs_url="https://razorpay.com/docs/x/payouts/best-practices/",
        setup_steps=(
            "Open a RazorpayX current account (x.razorpay.com). It uses the same API keys as Razorpay payments.",
            "Allowlist the server's outbound IP in RazorpayX → Developer controls (the NAT gateway IP from Terraform output).",
            "Copy your RazorpayX account number here.",
            "Add a webhook with the URL shown here and the payout events listed, then paste its secret here.",
            "Switch on. New payouts are sent with an idempotency key, so a retry never pays twice.",
        ),
    ),
    Provider(
        key="msg91",
        name="MSG91 SMS",
        group="messaging",
        purpose="Sends login OTPs and order SMS. Until it is on, OTPs only appear in the server log (development).",
        needed_for_launch=True,
        fields=(
            FieldDef("auth_key", "Auth key", "msg91_auth_key", kind="secret", required=True, help="MSG91 → API → Auth key."),
            FieldDef("otp_template_id", "OTP template ID", "msg91_otp_template_id", required=True, pattern=r"[A-Za-z0-9]{8,40}",
                     pattern_hint="Letters and digits", help="MSG91 → OTP → template. The text must match your DLT-approved OTP template."),
            FieldDef("sender_id", "Sender ID (DLT header)", "msg91_sender_id", pattern=r"[A-Z]{6}", pattern_hint="6 capital letters", placeholder="PIXCRT"),
            FieldDef("dlt_entity_id", "DLT entity ID", "msg91_dlt_entity_id", pattern=r"[0-9]{10,25}", pattern_hint="Digits from your DLT portal",
                     help="For your records and support tickets; templates are linked to it on the DLT portal."),
        ),
        on={"sms_provider": "msg91"},
        off={"sms_provider": "console"},
        default_on="sms_provider==msg91",
        docs_url="https://docs.msg91.com/",
        setup_steps=(
            "Register your business and the sender ID on a DLT portal (Jio, Vodafone Idea, Airtel or BSNL). Approval takes 2–7 days.",
            "Register the OTP template and each order-SMS template on DLT, then add them in MSG91 with the DLT template IDs.",
            "Copy the MSG91 auth key and the OTP template ID here and switch on.",
            "Use Test connection with your own mobile number: you should get an SMS within a minute.",
        ),
    ),
    Provider(
        key="email",
        name="Email (Amazon SES or any SMTP)",
        group="messaging",
        purpose="Order, seller and support emails.",
        needed_for_launch=True,
        fields=(
            FieldDef("host", "SMTP host", "smtp_host", required=True, pattern=r"[A-Za-z0-9.-]{3,253}", pattern_hint="A host name",
                     placeholder="email-smtp.ap-south-1.amazonaws.com"),
            FieldDef("port", "Port", "smtp_port", kind="number", min=1, max=65535, placeholder="587"),
            FieldDef("security", "Connection security", "smtp_security", kind="select", options=("starttls", "ssl", "none")),
            FieldDef("user", "SMTP user", "smtp_user", help="SES → SMTP settings → Create SMTP credentials."),
            FieldDef("password", "SMTP password", "smtp_password", kind="secret"),
            FieldDef("from_address", "Sender address", "smtp_from", kind="email", required=True, placeholder="orders@yourdomain.in",
                     help="Must be on a domain verified in SES. The display name is your brand name."),
        ),
        off={"smtp_host": ""},
        default_on="smtp_host",
        docs_url="https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html",
        setup_steps=(
            "In Amazon SES (ap-south-1), verify your domain: add the DKIM CNAME records it gives you in Route 53.",
            "Request production access in SES so you can email any address (sandbox only reaches verified addresses).",
            "SES → SMTP settings → Create SMTP credentials. Copy the user and password here.",
            "Enter a sender address on the verified domain, save, and send a test email to yourself.",
        ),
    ),
    Provider(
        key="whatsapp",
        name="WhatsApp Cloud API",
        group="messaging",
        purpose="Order updates on WhatsApp using approved message templates.",
        fields=(
            FieldDef("phone_number_id", "Phone number ID", "whatsapp_phone_number_id", required=True, pattern=r"[0-9]{6,25}", pattern_hint="Digits"),
            FieldDef("token", "Permanent access token", "whatsapp_token", kind="secret", required=True,
                     help="Meta Business → System users → Generate token with whatsapp_business_messaging."),
            FieldDef("language", "Template language code", "whatsapp_language", pattern=r"[a-z]{2}(_[A-Z]{2})?", pattern_hint="e.g. en or en_US", placeholder="en"),
            FieldDef("api_version", "Graph API version", "whatsapp_api_version", pattern=r"v[0-9]{2}\.[0-9]", pattern_hint="e.g. v21.0", placeholder="v21.0"),
        ),
        off={"whatsapp_token": ""},
        default_on="whatsapp_token",
        docs_url="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
        setup_steps=(
            "Create a Meta Business account and a WhatsApp Business app at developers.facebook.com.",
            "Add and verify your business phone number; copy its Phone number ID here.",
            "Create a system user, give it the app, and generate a permanent token with whatsapp_business_messaging.",
            "Create message templates in WhatsApp Manager and enter their names in Admin → Notifications.",
        ),
    ),
    Provider(
        key="shiprocket",
        name="Shiprocket",
        group="shipping",
        purpose="Books couriers, prints labels and updates tracking automatically.",
        fields=(
            FieldDef("email", "API user email", "shiprocket_email", kind="email", required=True,
                     help="Shiprocket → Settings → API → Create an API user (a separate login just for the API)."),
            FieldDef("password", "API user password", "shiprocket_password", kind="secret", required=True),
            FieldDef("webhook_token", "Webhook token", "shiprocket_webhook_token", kind="secret", required=True,
                     help="Any long random text. Shiprocket sends it in the x-api-key header."),
        ),
        on={"shipping_provider": "shiprocket"},
        off={"shipping_provider": "manual"},
        default_on="shipping_provider==shiprocket",
        webhook_path="/api/webhooks/shiprocket",
        webhook_events=("Tracking updates",),
        docs_url="https://apidocs.shiprocket.in/",
        setup_steps=(
            "Shiprocket → Settings → API → Configure → create an API user. Copy its email and password here.",
            "Settings → API → Webhooks: paste the webhook URL shown here and the same token, then save.",
            "Each seller warehouse becomes a Shiprocket pickup location the first time an order ships from it.",
        ),
    ),
    Provider(
        key="ai",
        name="AI provider (Claude by Anthropic)",
        group="ai",
        purpose="Powers the admin AI assistant and AI studio drafts. Without a key the AI features run in sandbox mode.",
        fields=(
            FieldDef("provider", "Provider", "ai_provider", kind="select", options=("anthropic",),
                     help="Claude through the Anthropic API. The model and monthly budget are set in AI studio."),
            FieldDef("api_key", "API key", "anthropic_api_key", kind="secret", required=True,
                     help="console.anthropic.com → API keys. Set a monthly spend limit there too."),
            FieldDef("api_base", "API address", "anthropic_api_base", kind="url", pattern=r"https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?",
                     pattern_hint="An https address", placeholder="https://api.anthropic.com",
                     help="Leave as is unless you route through a company proxy."),
        ),
        off={"anthropic_api_key": ""},
        default_on="anthropic_api_key",
        docs_url="https://docs.claude.com/en/api/overview",
        setup_steps=(
            "Create an organisation at console.anthropic.com and add billing.",
            "Settings → Limits: set a monthly spend limit you are comfortable with.",
            "API keys → Create key (one key per environment). Paste it here, save and press Test connection.",
            "Choose the model and the monthly token budget in Admin → AI studio.",
        ),
    ),
    Provider(
        key="sentry",
        name="Sentry error tracking",
        group="monitoring",
        purpose="Reports server errors with stack traces. No personal data is sent.",
        fields=(
            FieldDef("dsn", "DSN", "sentry_dsn", kind="secret", required=True, pattern=r"https://[A-Za-z0-9]+@[A-Za-z0-9.-]+(:[0-9]+)?/[0-9]+",
                     pattern_hint="https://key@o123.ingest.sentry.io/456"),
            FieldDef("traces_sample_rate", "Performance sample rate", "sentry_traces_sample_rate", kind="number", min=0, max=1, placeholder="0.05"),
        ),
        off={"sentry_dsn": ""},
        default_on="sentry_dsn",
        docs_url="https://docs.sentry.io/platforms/python/integrations/fastapi/",
        setup_steps=("Create a Python/FastAPI project in Sentry and copy its DSN here.", "Save; the server starts reporting within a minute."),
    ),
    Provider(
        key="analytics",
        name="Storefront analytics",
        group="analytics",
        purpose="Google Analytics 4 and Meta Pixel on the storefront (never on admin or seller pages).",
        fields=(
            FieldDef("ga4_measurement_id", "Google Analytics 4 measurement ID", "ga4_measurement_id", pattern=r"G-[A-Z0-9]{4,15}", pattern_hint="G-XXXXXXX"),
            FieldDef("meta_pixel_id", "Meta Pixel ID", "meta_pixel_id", pattern=r"[0-9]{8,20}", pattern_hint="Digits"),
            FieldDef("need_consent", "Ask visitors before loading trackers", "analytics_need_consent", kind="bool",
                     help="Recommended under the DPDP Act: trackers load only after the visitor accepts."),
        ),
        off={"ga4_measurement_id": "", "meta_pixel_id": ""},
        default_on="ga4_measurement_id|meta_pixel_id",
        testable=False,
        docs_url="https://support.google.com/analytics/answer/9539598",
        setup_steps=("Copy the measurement ID from GA4 → Admin → Data streams.", "Copy the Pixel ID from Meta Events Manager.", "Save and switch on."),
    ),
)

BY_KEY = {p.key: p for p in PROVIDERS}

GROUP_LABELS = {
    "payments": "Payments and payouts",
    "messaging": "SMS, email and WhatsApp",
    "shipping": "Shipping",
    "ai": "AI",
    "monitoring": "Monitoring",
    "analytics": "Analytics",
}


def default_switch(provider: Provider, settings: Any) -> bool:
    """Whether the provider counts as on when nobody has used the switch in the admin panel."""
    for part in provider.default_on.split("|"):
        if "==" in part:
            attr, want = part.split("==", 1)
            if str(getattr(settings, attr, "")) == want:
                return True
        elif part and getattr(settings, part, ""):
            return True
    return False


def validate_value(f: FieldDef, value: Any) -> Any:
    """Returns the cleaned value or raises ValueError with a message an admin can act on."""
    if f.kind == "bool":
        if not isinstance(value, bool):
            raise ValueError(f"{f.label}: choose on or off")
        return value
    if f.kind == "number":
        try:
            num = float(value) if f.setting.endswith("rate") else int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{f.label}: enter a number") from None
        if (f.min is not None and num < f.min) or (f.max is not None and num > f.max):
            raise ValueError(f"{f.label}: must be between {f.min:g} and {f.max:g}")
        return num
    if not isinstance(value, str):
        raise ValueError(f"{f.label}: enter text")
    v = value.strip()
    if any(ord(c) < 32 for c in v):
        raise ValueError(f"{f.label}: remove line breaks and hidden characters")
    if len(v) > 500:
        raise ValueError(f"{f.label}: too long")
    if f.kind == "select" and v not in f.options:
        raise ValueError(f"{f.label}: choose one of {', '.join(f.options)}")
    if f.kind == "email" and v and not re.fullmatch(r"[^@\s<>]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", v):
        raise ValueError(f"{f.label}: enter an email address")
    if f.kind == "url" and v and not v.startswith("https://"):
        raise ValueError(f"{f.label}: must start with https://")
    if f.pattern and v and not re.fullmatch(f.pattern, v):
        raise ValueError(f"{f.label}: {f.pattern_hint or 'check the format'}")
    return v
