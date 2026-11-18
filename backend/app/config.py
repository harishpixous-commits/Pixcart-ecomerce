"""Application settings, read from the environment (and an optional .env file).

Production refuses to start with unsafe defaults (see ``validate_for_production``).
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    app_name: str = "PixCart"
    public_web_url: str = "http://localhost:3000"  # storefront origin, used in links/CORS
    cors_origins: str = "http://localhost:3000"  # comma separated

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/pixcart"

    # --- auth -----------------------------------------------------------------
    jwt_secret: str = "dev-only-change-me-dev-only-change-me"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    refresh_cookie_name: str = "pc_refresh"
    cookie_secure: bool = False  # True in production (HTTPS)

    # Fernet key (urlsafe base64, 32 bytes) for PAN / bank account numbers at rest.
    field_encryption_key: str = "62P9O54u1vWja43dxBhdx7DlDaxYQVgo27zjo_K_4fU="

    otp_length: int = 6
    otp_ttl_seconds: int = 300
    otp_max_attempts: int = 5
    otp_resend_cooldown_seconds: int = 30
    otp_max_per_hour: int = 5

    # --- SMS (OTP delivery) -----------------------------------------------------
    sms_provider: Literal["console", "msg91"] = "console"
    msg91_auth_key: str = ""
    msg91_otp_template_id: str = ""
    msg91_sender_id: str = ""  # 6-letter DLT header, e.g. PIXCRT
    msg91_dlt_entity_id: str = ""  # DLT principal entity ID (for your records; MSG91 maps templates to it)

    # --- payments -----------------------------------------------------------------
    razorpay_key_id: str = ""
    razorpay_key_secret: str = ""
    razorpay_webhook_secret: str = ""
    razorpay_api_base: str = "https://api.razorpay.com/v1"
    razorpay_checkout: bool = True  # Admin → Integrations switch; off hides online payment at checkout
    razorpay_checkout_url: str = "https://checkout.razorpay.com/v1/checkout.js"
    payment_window_minutes: int = 30  # unpaid online orders are cancelled after this

    # --- payouts (RazorpayX) ------------------------------------------------------
    payout_mode: Literal["manual", "razorpayx"] = "manual"
    razorpayx_account_number: str = ""  # RazorpayX customer identifier / current account number
    razorpayx_webhook_secret: str = ""

    # --- email / WhatsApp notifications ------------------------------------------------
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""  # sender address; the display name is the brand name from the storefront settings
    smtp_security: Literal["starttls", "ssl", "none"] = "starttls"
    whatsapp_phone_number_id: str = ""
    whatsapp_token: str = ""
    whatsapp_language: str = "en"
    whatsapp_api_version: str = "v21.0"
    whatsapp_api_base: str = "https://graph.facebook.com"

    # --- shipping ----------------------------------------------------------------------
    shipping_provider: Literal["manual", "shiprocket"] = "manual"
    shiprocket_email: str = ""
    shiprocket_password: str = ""
    shiprocket_webhook_token: str = ""
    shiprocket_api_base: str = "https://apiv2.shiprocket.in/v1/external"

    # --- AI (Anthropic) ------------------------------------------------------------------
    ai_provider: Literal["anthropic"] = "anthropic"
    anthropic_api_key: str = ""
    ai_model: str = "claude-haiku-5-5"
    anthropic_api_base: str = "https://api.anthropic.com"

    sentry_dsn: str = ""
    sentry_traces_sample_rate: float = 0.05


    msg91_api_base: str = "https://control.msg91.com"

    # --- media --------------------------------------------------------------------
    storage_backend: Literal["local", "s3"] = "local"
    media_root: str = "./var/media"  # public images (local backend)
    private_root: str = "./var/private"  # seller KYC documents (local backend)
    media_base_url: str = "/media"  # public URL prefix for images
    s3_bucket: str = ""
    s3_private_bucket: str = ""
    s3_region: str = "ap-south-1"
    max_image_bytes: int = 5 * 1024 * 1024
    max_document_bytes: int = 5 * 1024 * 1024

    run_jobs: bool = True  # in-process scheduler (expire unpaid orders, cleanup)
    log_format: Literal["console", "json"] = "console"
    trust_proxy_headers: bool = False  # true only behind a load balancer that appends X-Forwarded-For
    trusted_proxy_count: int = 1

    platform_legal_name: str = ""  # starting value for Admin → Storefront → Business; edited there afterwards
    platform_gstin: str = ""
    grievance_officer_name: str = ""
    grievance_officer_email: str = ""
    grievance_officer_phone: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def razorpay_enabled(self) -> bool:
        """Gateway calls are possible (refunds still work after checkout is switched off)."""
        return bool(self.razorpay_key_id and self.razorpay_key_secret)

    @property
    def online_payments(self) -> bool:
        """Customers can choose online payment at checkout."""
        return self.razorpay_enabled and self.razorpay_checkout

    def validate_for_production(self) -> None:
        if self.environment != "production":
            return
        problems = []
        if self.jwt_secret.startswith("dev-only") or len(self.jwt_secret) < 32:
            problems.append("JWT_SECRET must be a random value of at least 32 characters")
        if self.field_encryption_key == Settings.model_fields["field_encryption_key"].default:
            problems.append("FIELD_ENCRYPTION_KEY must be set (python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')")
        if not self.cookie_secure:
            problems.append("COOKIE_SECURE must be true in production")
        # Provider keys (Razorpay, MSG91, …) are not checked here: they can be added later in
        # Admin → Integrations, and Admin → Go-live shows what is still missing.
        if problems:
            raise RuntimeError("Unsafe production configuration:\n - " + "\n - ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
