# Runs the published IIS package (website + API on one address) on http://localhost:5180 against the parity copy of the
# demo data, configured like run-parity-api.ps1: for the demo videos (tools/handover-kit/video/chain_net.sh).
# Package: C:\Users\haris\pixcart-tools\parity-site (a copy of the output of tools/publish-windows.ps1).
$envFile = "C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace\backend\.env"
$map = @{
  "FIELD_ENCRYPTION_KEY" = "App__FieldEncryptionKey"; "SMTP_FROM" = "App__SmtpFrom"; "SMTP_PORT" = "App__SmtpPort";
  "PAYMENT_WINDOW_MINUTES" = "App__PaymentWindowMinutes"; "PAYOUT_MODE" = "App__PayoutMode";
  "WHATSAPP_LANGUAGE" = "App__WhatsappLanguage"; "SHIPPING_PROVIDER" = "App__ShippingProvider"; "AI_MODEL" = "App__AiModel";
  "APP_NAME" = "App__AppName"
}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$' -and $map.ContainsKey($Matches[1])) {
    $v = $Matches[2].Trim()
    if ($v.StartsWith('"')) { $v = $v.Substring(1, $v.IndexOf('"', 1) - 1) }   # quoted: up to the closing quote
    else { $v = ($v -replace '\s+#.*$', '').Trim() }                           # unquoted: a " # ..." comment is dropped (python-dotenv)
    if ($v -ne "") { Set-Item -Path ("Env:" + $map[$Matches[1]]) -Value $v }
  }
}
$env:App__ConnectionString = "Server=127.0.0.1;Port=3307;Database=pixcart_parity;User=root;Password=pixcart;"
$env:App__RunJobs = "false"
$env:App__MediaRoot = "C:\Users\haris\pixcart-tools\parity-media"
$env:App__PrivateRoot = "C:\Users\haris\pixcart-tools\parity-private"
$env:App__PublicWebUrl = "http://localhost:5180"
$env:App__CorsOrigins = "http://localhost:5180"
$env:App__RazorpayApiBase = "http://127.0.0.1:8790/v1"
$env:App__RazorpayCheckoutUrl = "http://127.0.0.1:8790/v1/checkout.js"
$env:App__RazorpayKeyId = "rzp_test_sim"
$env:App__RazorpayKeySecret = "sim_secret"
$env:App__RazorpayWebhookSecret = "sim_whsec"
$env:ASPNETCORE_URLS = "http://localhost:5180"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
Set-Location "C:\Users\haris\pixcart-tools\parity-site"
dotnet API.dll *>&1 | Out-File -Encoding utf8 "C:\Users\haris\pixcart-tools\parity-site.log"
