# Runs the published IIS package (API + website on one address, like the Windows host) on http://localhost:5300
# against the end-to-end test database (MySQL pixcart_e2e: fresh demo data + admin@pixcart.in), with the local
# payment simulator and sign-in codes written to the log the browser tests read.
$site = "C:\Users\haris\pixcart-tools\e2e-site"
$env:App__ConnectionString = "Server=127.0.0.1;Port=3307;Database=pixcart_e2e;User=root;Password=pixcart;"
$env:App__MediaRoot = "C:\Users\haris\pixcart-tools\e2e-site-media"
$env:App__PrivateRoot = "C:\Users\haris\pixcart-tools\e2e-site-private"
$env:App__PublicWebUrl = "http://localhost:5300"
$env:App__CorsOrigins = "http://localhost:5300"
$env:App__RazorpayApiBase = "http://127.0.0.1:8790/v1"
$env:App__RazorpayCheckoutUrl = "http://127.0.0.1:8790/v1/checkout.js"
$env:App__RazorpayKeyId = "rzp_test_sim"
$env:App__RazorpayKeySecret = "sim_secret"
$env:App__RazorpayWebhookSecret = "sim_whsec"
$env:ASPNETCORE_URLS = "http://localhost:5300"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
Set-Location $site
dotnet API.dll *>&1 | Out-File -Encoding utf8 "C:\Users\haris\pixcart-tools\e2e-api-net.log"
