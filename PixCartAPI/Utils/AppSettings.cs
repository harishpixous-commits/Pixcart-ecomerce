namespace Utils;

/// <summary>
/// Settings from appsettings.json (section "App") and environment variables (App__JwtSecret, ...).
/// Integration keys (Razorpay, SMS, email ...) can also be saved in Admin → Integrations, which wins over these.
/// </summary>
public class AppSettings
{
    public string Environment { get; set; } = "development";
    public string AppName { get; set; } = "PixCart";
    public string PublicWebUrl { get; set; } = "http://localhost:4200";
    public string CorsOrigins { get; set; } = "http://localhost:4200";
    public string ConnectionString { get; set; } = "Server=127.0.0.1;Port=3307;Database=pixcart;User=pixcart;Password=pixcart;";

    public string JwtSecret { get; set; } = "dev-only-change-me-dev-only-change-me";
    public int AccessTokenMinutes { get; set; } = 15;
    public int RefreshTokenDays { get; set; } = 30;
    public string RefreshCookieName { get; set; } = "pc_refresh";
    public bool CookieSecure { get; set; }
    /// <summary>Fernet key (urlsafe base64, 32 bytes) for PAN, bank numbers and saved integration keys. Same format as the reference version.</summary>
    public string FieldEncryptionKey { get; set; } = "62P9O54u1vWja43dxBhdx7DlDaxYQVgo27zjo_K_4fU=";

    public int OtpLength { get; set; } = 6;
    public int OtpTtlSeconds { get; set; } = 300;
    public int OtpMaxAttempts { get; set; } = 5;
    public int OtpResendCooldownSeconds { get; set; } = 30;
    public int OtpMaxPerHour { get; set; } = 5;
    public string SmsProvider { get; set; } = "console";
    public string Msg91AuthKey { get; set; } = "";
    public string Msg91TemplateId { get; set; } = "";
    public string Msg91SenderId { get; set; } = "";

    public string RazorpayKeyId { get; set; } = "";
    public string RazorpayKeySecret { get; set; } = "";
    public string RazorpayWebhookSecret { get; set; } = "";
    public string RazorpayApiBase { get; set; } = "https://api.razorpay.com/v1";
    /// <summary>Admin → Integrations switch; off hides online payment at checkout (reference: config.py razorpay_checkout).</summary>
    public bool RazorpayCheckout { get; set; } = true;
    public string RazorpayCheckoutUrl { get; set; } = "https://checkout.razorpay.com/v1/checkout.js";
    public int PaymentWindowMinutes { get; set; } = 30;

    public string SmtpHost { get; set; } = "";
    public int SmtpPort { get; set; } = 587;
    public string SmtpUser { get; set; } = "";
    public string SmtpPassword { get; set; } = "";
    public string SmtpFrom { get; set; } = "";
    public string SmtpSecurity { get; set; } = "starttls";

    public string AnthropicApiKey { get; set; } = "";
    public string AnthropicApiBase { get; set; } = "https://api.anthropic.com";
    public string AiModel { get; set; } = "claude-haiku-5-5";

    /// <summary>"local" (disk) or "ftp" (company FTP server, see FtpHost).</summary>
    public string StorageBackend { get; set; } = "local";
    public string MediaRoot { get; set; } = "./var/media";
    public string PrivateRoot { get; set; } = "./var/private";
    public string MediaBaseUrl { get; set; } = "/media";
    public string FtpHost { get; set; } = "";
    public int FtpPort { get; set; } = 21;
    public string FtpUser { get; set; } = "";
    public string FtpPassword { get; set; } = "";
    public string FtpBaseDir { get; set; } = "/";
    public long MaxImageBytes { get; set; } = 5 * 1024 * 1024;
    public long MaxDocumentBytes { get; set; } = 5 * 1024 * 1024;

    public bool RunJobs { get; set; } = true;
    public bool TrustProxyHeaders { get; set; }
    public int TrustedProxyCount { get; set; } = 1;

    public bool IsProduction => Environment == "production";
    public bool IsTest => Environment == "test";
    public IEnumerable<string> CorsOriginList => CorsOrigins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
