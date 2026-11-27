using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using BAL.Interface;
using Model.DomainModel.Integrations;
using static BAL.Payments.PaymentText;

namespace BAL.Payments;

/// <summary>Razorpay through the existing client (IRazorpayBAL): Orders, Payments, Refunds and Razorpay Checkout.</summary>
public sealed class RazorpayGateway(IRazorpayBAL razorpay) : IPaymentGateway
{
    public string Code => "razorpay";
    public string Name => "Razorpay";
    public string Mode => "modal";
    public bool CaptureNeeded => true;
    public bool Configured(IntegrationSettings c) => c.RazorpayEnabled;
    public bool SwitchedOn(IntegrationSettings c) => c.RazorpayCheckout;
    public IReadOnlySet<string>? Currencies(IntegrationSettings c) => null; // rupees, or the shopper's currency when the admin charges in it
    public bool Sandbox(IntegrationSettings c) => !c.RazorpayKeyId.StartsWith("rzp_live_", StringComparison.Ordinal);
    public bool WebhookReady(IntegrationSettings c) => c.RazorpayWebhookSecret.Length > 0;

    private static async Task<T> Wrap<T>(Func<Task<T>> call)
    {
        try { return await call(); }
        catch (RazorpayBAL.GatewayException e) { throw new PaymentGatewayException(e.Message); }
    }

    public async Task<CreatedPayment> CreateAsync(IntegrationSettings c, long amount, string currency, string receipt, PaymentCustomer customer,
        string returnUrl, string notifyUrl, CancellationToken ct = default)
    {
        var rp = await Wrap(() => razorpay.CreateOrderAsync(amount, receipt, new Dictionary<string, string> { ["order_number"] = receipt }, currency));
        var id = S(rp["id"]);
        return new CreatedPayment(id, new JsonObject { ["key_id"] = c.RazorpayKeyId, ["checkout_url"] = c.RazorpayCheckoutUrl, ["razorpay_order_id"] = id });
    }

    public async Task<IReadOnlyList<PaymentAttempt>> AttemptsAsync(IntegrationSettings c, string reference, CancellationToken ct = default) =>
        (await Wrap(() => razorpay.OrderPaymentsAsync(reference))).Select(a => new PaymentAttempt(S(a["id"]), S(a["status"]), MethodOf(S(a["method"])),
            L(a["amount"]), S(a["error_description"]), L(a["created_at"]))).ToList();

    public async Task<PaymentAttempt> CaptureAsync(IntegrationSettings c, PaymentAttempt attempt, long amount, string currency)
    {
        var data = await Wrap(() => razorpay.CapturePaymentAsync(attempt.Id, amount, currency));
        return attempt with { Status = S(data["status"]), Method = MethodOf(S(data["method"])), Amount = L(data["amount"]), Error = S(data["error_description"]) };
    }

    public async Task<RefundResult> RefundAsync(IntegrationSettings c, string paymentId, string reference, long amount, string currency, string refundId, string note)
    {
        var data = await Wrap(() => razorpay.RefundPaymentAsync(paymentId, amount, refundId, new Dictionary<string, string> { ["refund_id"] = refundId }));
        return new RefundResult(S(data["id"]), S(data["status"]) == "processed" ? "processed" : "pending");
    }

    public async Task<string> RefundStatusAsync(IntegrationSettings c, string reference, string refundId, string providerRefundId)
    {
        if (providerRefundId.Length == 0) return "unknown"; // Razorpay files refunds under its own id; a retry is safe (the receipt is our refund id)
        var status = S((await Wrap(() => razorpay.FetchRefundAsync(providerRefundId)))["status"]);
        return status is "processed" or "failed" ? status : "pending";
    }

    public string? VerifyWebhook(IntegrationSettings c, IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        var secret = c.RazorpayWebhookSecret;
        if (secret.Length == 0 || !SameText(Hex(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), body)), headers.GetValueOrDefault("x-razorpay-signature", "")))
            return null;
        if (PaymentHttp.Parse(Encoding.UTF8.GetString(body)) is not JsonObject root) return null;
        var payload = root["payload"] as JsonObject;
        var paymentOrder = S(payload?["payment"]?["entity"]?["order_id"]);
        return paymentOrder.Length > 0 ? paymentOrder : S(payload?["order"]?["entity"]?["id"]);
    }

    public string ReferenceFromReturn(IReadOnlyDictionary<string, string> data) => Cut(data.GetValueOrDefault("razorpay_order_id", ""), 100);

    public async Task<string> TestAsync(IntegrationSettings c)
    {
        if (!Configured(c)) throw new PaymentGatewayException("Enter the Key ID and Key secret first.");
        try
        {
            await razorpay.ListOrdersAsync(1);
        }
        catch (RazorpayBAL.GatewayException e)
        {
            throw new PaymentGatewayException(e.Message.Contains("Authentication", StringComparison.OrdinalIgnoreCase)
                ? "Razorpay rejected the Key ID or Key secret. Copy both again from the dashboard." : e.Message);
        }
        var mode = c.RazorpayKeyId.StartsWith("rzp_test_", StringComparison.Ordinal) ? "test" : "live";
        return $"Connected to Razorpay in {mode} mode.{(c.RazorpayWebhookSecret.Length > 0 ? "" : " Add the webhook secret too.")}";
    }
}

/// <summary>Cashfree Payments (PG API version 2023-08-01): orders, payments, refunds and the Cashfree JS SDK checkout.</summary>
public sealed class CashfreeGateway(PaymentHttp http) : IPaymentGateway
{
    public const string ApiVersion = "2023-08-01";
    public const string SdkUrl = "https://sdk.cashfree.com/js/v3/cashfree.js";
    private static readonly Dictionary<string, string> States = new()
    {
        ["SUCCESS"] = "captured", ["PENDING"] = "pending", ["NOT_ATTEMPTED"] = "created", ["FAILED"] = "failed", ["USER_DROPPED"] = "failed",
        ["CANCELLED"] = "failed", ["VOID"] = "failed", ["FLAGGED"] = "pending",
    };

    public string Code => "cashfree";
    public string Name => "Cashfree Payments";
    public string Mode => "modal";
    public bool RefundLookupByOurId => true;
    public bool Configured(IntegrationSettings c) => c.CashfreeClientId.Length > 0 && c.CashfreeClientSecret.Length > 0;
    public bool SwitchedOn(IntegrationSettings c) => c.CashfreeCheckout;
    public bool Sandbox(IntegrationSettings c) => c.CashfreeClientId.ToUpperInvariant().StartsWith("TEST", StringComparison.Ordinal);
    public string Base(IntegrationSettings c) =>
        (c.CashfreeApiBase.Length > 0 ? c.CashfreeApiBase : Sandbox(c) ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg").TrimEnd('/');

    private HttpRequestMessage Req(IntegrationSettings c, HttpMethod method, string path, JsonNode? body)
    {
        var r = PaymentHttp.Json(method, Base(c) + path, body);
        r.Headers.Add("x-client-id", c.CashfreeClientId);
        r.Headers.Add("x-client-secret", c.CashfreeClientSecret);
        r.Headers.Add("x-api-version", ApiVersion);
        return r;
    }

    private async Task<JsonNode?> Call(IntegrationSettings c, HttpMethod method, string path, JsonNode? body = null, CancellationToken ct = default)
    {
        if (!Configured(c)) throw new PaymentGatewayException("Cashfree is not configured");
        var (status, text) = await http.SendAsync("Cashfree", Req(c, method, path, body), 15, ct);
        if (status >= 400) throw new PaymentGatewayException(PaymentHttp.ErrorText(text, "message") is { Length: > 0 } e ? e : $"Cashfree error ({status})");
        return PaymentHttp.Parse(text);
    }

    private static double RupeesNumber(long paise) => double.Parse(Rupees(paise), CultureInfo.InvariantCulture);

    public async Task<CreatedPayment> CreateAsync(IntegrationSettings c, long amount, string currency, string receipt, PaymentCustomer customer,
        string returnUrl, string notifyUrl, CancellationToken ct = default)
    {
        if (customer.Phone.Length == 0) throw new NotApplicableException("Cashfree needs the shopper's mobile number");
        var orderId = Cut($"{receipt}-{Hex(RandomNumberGenerator.GetBytes(3))}", 45);
        var details = new JsonObject
        {
            ["customer_id"] = "c" + customer.Phone, ["customer_phone"] = customer.Phone, ["customer_name"] = Cut(customer.Name.Length > 0 ? customer.Name : "Customer", 100),
        };
        if (customer.Email.Length > 0) details["customer_email"] = customer.Email;
        var data = await Call(c, HttpMethod.Post, "/orders", new JsonObject
        {
            ["order_id"] = orderId, ["order_amount"] = RupeesNumber(amount), ["order_currency"] = currency, ["customer_details"] = details,
            ["order_meta"] = new JsonObject { ["return_url"] = returnUrl + "?order_id={order_id}", ["notify_url"] = notifyUrl }, ["order_note"] = $"Order {receipt}",
        }, ct);
        var session = S(data?["payment_session_id"]);
        if (session.Length == 0) throw new PaymentGatewayException("Cashfree did not return a payment session");
        return new CreatedPayment(orderId, new JsonObject
        {
            ["sdk_url"] = c.CashfreeSdkUrl.Length > 0 ? c.CashfreeSdkUrl : SdkUrl, ["env"] = Sandbox(c) ? "sandbox" : "production", ["payment_session_id"] = session,
        });
    }

    public async Task<IReadOnlyList<PaymentAttempt>> AttemptsAsync(IntegrationSettings c, string reference, CancellationToken ct = default)
    {
        var rows = await Call(c, HttpMethod.Get, $"/orders/{reference}/payments", null, ct) as JsonArray;
        var outp = new List<PaymentAttempt>();
        foreach (var p in rows ?? [])
        {
            long when = 0;
            if (DateTimeOffset.TryParse(S(p?["payment_time"]), CultureInfo.InvariantCulture, DateTimeStyles.None, out var t)) when = t.ToUnixTimeSeconds();
            var status = States.GetValueOrDefault(S(p?["payment_status"]).ToUpperInvariant(), "pending");
            outp.Add(new PaymentAttempt(S(p?["cf_payment_id"]), status, MethodOf(S(p?["payment_group"])), PaiseOf(p?["payment_amount"]),
                status == "failed" ? S(p?["payment_message"]) : "", when));
        }
        return outp;
    }

    public async Task<RefundResult> RefundAsync(IntegrationSettings c, string paymentId, string reference, long amount, string currency, string refundId, string note)
    {
        var data = await Call(c, HttpMethod.Post, $"/orders/{reference}/refunds",
            new JsonObject { ["refund_amount"] = RupeesNumber(amount), ["refund_id"] = Cut(refundId, 40), ["refund_note"] = Cut(note, 100) });
        var cf = S(data?["cf_refund_id"]);
        return new RefundResult(cf.Length > 0 ? cf : refundId, S(data?["refund_status"]).ToUpperInvariant() == "SUCCESS" ? "processed" : "pending");
    }

    public async Task<string> RefundStatusAsync(IntegrationSettings c, string reference, string refundId, string providerRefundId)
    {
        if (!Configured(c)) throw new PaymentGatewayException("Cashfree is not configured");
        var (status, text) = await http.SendAsync("Cashfree", Req(c, HttpMethod.Get, $"/orders/{reference}/refunds/{Cut(refundId, 40)}", null));
        if (status == 404) return "unknown";
        if (status >= 400) throw new PaymentGatewayException(PaymentHttp.ErrorText(text, "message") is { Length: > 0 } e ? e : $"Cashfree error ({status})");
        var s = S(PaymentHttp.Parse(text)?["refund_status"]).ToUpperInvariant();
        return s == "SUCCESS" ? "processed" : s is "CANCELLED" or "FAILED" ? "failed" : "pending";
    }

    public string? VerifyWebhook(IntegrationSettings c, IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        var ts = headers.GetValueOrDefault("x-webhook-timestamp", "");
        var sig = headers.GetValueOrDefault("x-webhook-signature", "");
        if (c.CashfreeClientSecret.Length == 0 || ts.Length == 0 || sig.Length == 0) return null;
        var expected = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(c.CashfreeClientSecret), Encoding.UTF8.GetBytes(ts).Concat(body).ToArray()));
        if (!SameText(expected, sig)) return null;
        if (PaymentHttp.Parse(Encoding.UTF8.GetString(body)) is not JsonObject root) return null;
        var data = root["data"] as JsonObject;
        var order = S(data?["order"]?["order_id"]);
        return order.Length > 0 ? order : S(data?["refund"]?["order_id"]);
    }

    public string ReferenceFromReturn(IReadOnlyDictionary<string, string> data) => Cut(data.GetValueOrDefault("order_id", ""), 100);

    public async Task<string> TestAsync(IntegrationSettings c)
    {
        if (!Configured(c)) throw new PaymentGatewayException("Enter the client id and client secret first.");
        var (status, text) = await http.SendAsync("Cashfree", Req(c, HttpMethod.Get, "/orders/pixcart-connection-test", null));
        if (status is 401 or 403) throw new PaymentGatewayException("Cashfree refused the keys: " + PaymentHttp.ErrorText(text, "message"));
        if (status >= 500) throw new PaymentGatewayException($"Cashfree error ({status})");
        return $"Keys accepted ({(Sandbox(c) ? "sandbox" : "live")})";
    }
}

/// <summary>PhonePe Payment Gateway, standard checkout v2: OAuth client credentials, pay, order status and refunds.</summary>
public sealed class PhonePeGateway(PaymentHttp http) : IPaymentGateway
{
    private static readonly Dictionary<string, string> States = new() { ["COMPLETED"] = "captured", ["PENDING"] = "pending", ["FAILED"] = "failed" };
    /// <summary>client id -> (access token, expires at in unix seconds).</summary>
    public static readonly ConcurrentDictionary<string, (string Token, double ExpiresAt)> Tokens = new();

    public string Code => "phonepe";
    public string Name => "PhonePe Payment Gateway";
    public string Mode => "redirect";
    public bool RefundLookupByOurId => true;
    public bool Configured(IntegrationSettings c) => c.PhonepeClientId.Length > 0 && c.PhonepeClientSecret.Length > 0;
    public bool SwitchedOn(IntegrationSettings c) => c.PhonepeCheckout;
    public bool Sandbox(IntegrationSettings c) => c.PhonepeEnv != "live";
    public bool WebhookReady(IntegrationSettings c) => c.PhonepeWebhookUsername.Length > 0 && c.PhonepeWebhookPassword.Length > 0;
    private string Api(IntegrationSettings c) =>
        (c.PhonepeApiBase.Length > 0 ? c.PhonepeApiBase : Sandbox(c) ? "https://api-preprod.phonepe.com/apis/pg-sandbox" : "https://api.phonepe.com/apis/pg").TrimEnd('/');
    private string Auth(IntegrationSettings c) =>
        (c.PhonepeAuthBase.Length > 0 ? c.PhonepeAuthBase : Sandbox(c) ? "https://api-preprod.phonepe.com/apis/pg-sandbox" : "https://api.phonepe.com/apis/identity-manager").TrimEnd('/');
    private static double Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;

    private async Task<string> TokenAsync(IntegrationSettings c, CancellationToken ct)
    {
        if (Tokens.TryGetValue(c.PhonepeClientId, out var cached) && cached.ExpiresAt - 60 > Now) return cached.Token;
        var (status, text) = await http.SendAsync("PhonePe", PaymentHttp.Form(HttpMethod.Post, Auth(c) + "/v1/oauth/token", new Dictionary<string, string>
        {
            ["client_id"] = c.PhonepeClientId, ["client_version"] = c.PhonepeClientVersion.Length > 0 ? c.PhonepeClientVersion : "1",
            ["client_secret"] = c.PhonepeClientSecret, ["grant_type"] = "client_credentials",
        }), 15, ct);
        if (status >= 400) throw new PaymentGatewayException("PhonePe refused the keys: " + PaymentHttp.ErrorText(text, "message", "code"));
        var data = PaymentHttp.Parse(text);
        var token = S(data?["access_token"]);
        if (token.Length == 0) throw new PaymentGatewayException("PhonePe did not return an access token");
        var expires = L(data?["expires_at"]);
        Tokens[c.PhonepeClientId] = (token, expires > 0 ? expires : Now + 600);
        return token;
    }

    private async Task<JsonNode?> Call(IntegrationSettings c, HttpMethod method, string path, JsonNode? body = null, CancellationToken ct = default)
    {
        if (!Configured(c)) throw new PaymentGatewayException("PhonePe is not configured");
        var token = await TokenAsync(c, ct);
        var req = PaymentHttp.Json(method, Api(c) + path, body);
        req.Headers.TryAddWithoutValidation("Authorization", "O-Bearer " + token);
        var (status, text) = await http.SendAsync("PhonePe", req, 15, ct);
        if (status == 401) Tokens.TryRemove(c.PhonepeClientId, out _);
        if (status >= 400) throw new PaymentGatewayException(PaymentHttp.ErrorText(text, "message", "code") is { Length: > 0 } e ? e : $"PhonePe error ({status})");
        return PaymentHttp.Parse(text);
    }

    public async Task<CreatedPayment> CreateAsync(IntegrationSettings c, long amount, string currency, string receipt, PaymentCustomer customer,
        string returnUrl, string notifyUrl, CancellationToken ct = default)
    {
        var merchantOrderId = Cut($"{receipt}-{Hex(RandomNumberGenerator.GetBytes(3))}", 63);
        var data = await Call(c, HttpMethod.Post, "/checkout/v2/pay", new JsonObject
        {
            ["merchantOrderId"] = merchantOrderId, ["amount"] = amount, ["expireAfter"] = 1800, ["metaInfo"] = new JsonObject { ["udf1"] = receipt },
            ["paymentFlow"] = new JsonObject
            {
                ["type"] = "PG_CHECKOUT", ["message"] = $"Order {receipt}",
                ["merchantUrls"] = new JsonObject { ["redirectUrl"] = $"{returnUrl}?merchantOrderId={merchantOrderId}" },
            },
        }, ct);
        var url = S(data?["redirectUrl"]);
        if (url.Length == 0) throw new PaymentGatewayException("PhonePe did not return a payment page");
        return new CreatedPayment(merchantOrderId, new JsonObject { ["url"] = url });
    }

    public async Task<IReadOnlyList<PaymentAttempt>> AttemptsAsync(IntegrationSettings c, string reference, CancellationToken ct = default)
    {
        var data = await Call(c, HttpMethod.Get, $"/checkout/v2/order/{reference}/status", null, ct);
        var outp = new List<PaymentAttempt>();
        foreach (var p in data?["paymentDetails"] as JsonArray ?? [])
        {
            var status = States.GetValueOrDefault(S(p?["state"]).ToUpperInvariant(), "pending");
            var error = S(p?["detailedErrorCode"]);
            if (error.Length == 0) error = S(p?["errorCode"]);
            outp.Add(new PaymentAttempt(S(p?["transactionId"]), status, MethodOf(S(p?["paymentMode"])), L(p?["amount"]), status == "failed" ? error : "",
                L(p?["timestamp"]) / 1000));
        }
        return outp;
    }

    public async Task<RefundResult> RefundAsync(IntegrationSettings c, string paymentId, string reference, long amount, string currency, string refundId, string note)
    {
        var data = await Call(c, HttpMethod.Post, "/payments/v2/refund",
            new JsonObject { ["merchantRefundId"] = Cut(refundId, 63), ["originalMerchantOrderId"] = reference, ["amount"] = amount });
        var id = S(data?["refundId"]);
        return new RefundResult(id.Length > 0 ? id : refundId, S(data?["state"]).ToUpperInvariant() == "COMPLETED" ? "processed" : "pending");
    }

    public async Task<string> RefundStatusAsync(IntegrationSettings c, string reference, string refundId, string providerRefundId)
    {
        if (!Configured(c)) throw new PaymentGatewayException("PhonePe is not configured");
        var token = await TokenAsync(c, default);
        var req = PaymentHttp.Json(HttpMethod.Get, $"{Api(c)}/payments/v2/refund/{Cut(refundId, 63)}/status", null);
        req.Headers.TryAddWithoutValidation("Authorization", "O-Bearer " + token);
        var (status, text) = await http.SendAsync("PhonePe", req);
        if (status is 400 or 404) return "unknown";
        if (status >= 400) throw new PaymentGatewayException(PaymentHttp.ErrorText(text, "message", "code") is { Length: > 0 } e ? e : $"PhonePe error ({status})");
        var state = S(PaymentHttp.Parse(text)?["state"]).ToUpperInvariant();
        return state == "COMPLETED" ? "processed" : state == "FAILED" ? "failed" : "pending";
    }

    public string? VerifyWebhook(IntegrationSettings c, IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        if (!WebhookReady(c)) return null;
        var expected = Hex(SHA256.HashData(Encoding.UTF8.GetBytes($"{c.PhonepeWebhookUsername}:{c.PhonepeWebhookPassword}")));
        if (!SameText(expected, headers.GetValueOrDefault("authorization", "").Trim().ToLowerInvariant())) return null;
        if (PaymentHttp.Parse(Encoding.UTF8.GetString(body)) is not JsonObject root) return null;
        var payload = root["payload"] as JsonObject;
        var order = S(payload?["merchantOrderId"]);
        return order.Length > 0 ? order : S(payload?["originalMerchantOrderId"]);
    }

    public string ReferenceFromReturn(IReadOnlyDictionary<string, string> data) => Cut(data.GetValueOrDefault("merchantOrderId", ""), 100);

    public async Task<string> TestAsync(IntegrationSettings c)
    {
        if (!Configured(c)) throw new PaymentGatewayException("Enter the client id and client secret first.");
        Tokens.TryRemove(c.PhonepeClientId, out _);
        await TokenAsync(c, default);
        return $"Keys accepted ({(Sandbox(c) ? "sandbox" : "live")})";
    }
}

/// <summary>PayU hosted checkout: the payment form (SHA-512 hash), verify_payment, refunds and the signed response.</summary>
public sealed class PayUGateway(PaymentHttp http) : IPaymentGateway
{
    private static readonly Dictionary<string, string> States = new()
    {
        ["success"] = "captured", ["pending"] = "pending", ["failure"] = "failed", ["failed"] = "failed", ["dropped"] = "failed", ["bounced"] = "failed",
        ["usercancelled"] = "failed",
    };

    public string Code => "payu";
    public string Name => "PayU";
    public string Mode => "form";
    public bool Configured(IntegrationSettings c) => c.PayuKey.Length > 0 && c.PayuSalt.Length > 0;
    public bool SwitchedOn(IntegrationSettings c) => c.PayuCheckout;
    public bool Sandbox(IntegrationSettings c) => c.PayuEnv != "live";
    private string Base(IntegrationSettings c) => (c.PayuBase.Length > 0 ? c.PayuBase : Sandbox(c) ? "https://test.payu.in" : "https://secure.payu.in").TrimEnd('/');
    private string Info(IntegrationSettings c) => (c.PayuInfoBase.Length > 0 ? c.PayuInfoBase : Sandbox(c) ? "https://test.payu.in" : "https://info.payu.in").TrimEnd('/');

    private static string Sha512(params string[] parts) => Hex(SHA512.HashData(Encoding.UTF8.GetBytes(string.Join("|", parts))));

    /// <summary>key|txnid|amount|productinfo|firstname|email|udf1..udf5|5 empty|salt (all udfs empty).</summary>
    public static string RequestHash(string key, string salt, string txnid, string amount, string productinfo, string firstname, string email) =>
        Sha512([key, txnid, amount, productinfo, firstname, email, .. Enumerable.Repeat("", 10), salt]);

    /// <summary>salt|status|5 empty|udf5..udf1|email|firstname|productinfo|amount|txnid|key, with additional charges in front when sent.</summary>
    public static string ResponseHash(string salt, IReadOnlyDictionary<string, string> d)
    {
        string G(string k) => d.GetValueOrDefault(k, "");
        var parts = new List<string> { salt, G("status"), "", "", "", "", "", G("udf5"), G("udf4"), G("udf3"), G("udf2"), G("udf1"), G("email"), G("firstname"),
            G("productinfo"), G("amount"), G("txnid"), G("key") };
        if (G("additional_charges").Length > 0) parts.Insert(0, G("additional_charges"));
        return Sha512([.. parts]);
    }

    private async Task<JsonNode?> Command(IntegrationSettings c, string command, Dictionary<string, string> variables, CancellationToken ct = default)
    {
        if (!Configured(c)) throw new PaymentGatewayException("PayU is not configured");
        var form = new Dictionary<string, string>
        {
            ["key"] = c.PayuKey, ["command"] = command, ["hash"] = Sha512(c.PayuKey, command, variables.GetValueOrDefault("var1", ""), c.PayuSalt),
        };
        foreach (var kv in variables) form[kv.Key] = kv.Value;
        var (status, text) = await http.SendAsync("PayU", PaymentHttp.Form(HttpMethod.Post, Info(c) + "/merchant/postservice.php?form=2", form), 15, ct);
        if (status >= 400) throw new PaymentGatewayException($"PayU error ({status})");
        return PaymentHttp.Parse(text) ?? throw new PaymentGatewayException("PayU answered something unexpected");
    }

    public Task<CreatedPayment> CreateAsync(IntegrationSettings c, long amount, string currency, string receipt, PaymentCustomer customer,
        string returnUrl, string notifyUrl, CancellationToken ct = default)
    {
        if (!Configured(c)) throw new PaymentGatewayException("PayU is not configured");
        var txnid = Cut($"{(receipt.Length > 18 ? receipt[^18..] : receipt)}-{Hex(RandomNumberGenerator.GetBytes(3))}", 25);
        var amountText = Rupees(amount);
        var productinfo = Cut($"Order {receipt}", 100);
        var name = customer.Name.Trim();
        var firstname = name.Length > 0 ? Cut(name.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)[0], 60) : "Customer";
        var email = customer.Email.Length > 0 ? customer.Email : $"order-{receipt.ToLowerInvariant()}@payments.invalid";
        var fields = new JsonObject
        {
            ["key"] = c.PayuKey, ["txnid"] = txnid, ["amount"] = amountText, ["productinfo"] = productinfo, ["firstname"] = firstname, ["email"] = email,
            ["phone"] = customer.Phone, ["surl"] = returnUrl, ["furl"] = returnUrl,
            ["hash"] = RequestHash(c.PayuKey, c.PayuSalt, txnid, amountText, productinfo, firstname, email),
        };
        return Task.FromResult(new CreatedPayment(txnid, new JsonObject { ["action"] = Base(c) + "/_payment", ["fields"] = fields }));
    }

    public async Task<IReadOnlyList<PaymentAttempt>> AttemptsAsync(IntegrationSettings c, string reference, CancellationToken ct = default)
    {
        var data = await Command(c, "verify_payment", new() { ["var1"] = reference }, ct);
        var row = data?["transaction_details"]?[reference] as JsonObject;
        var status = S(row?["status"]).ToLowerInvariant();
        if (row is null || status is "not found" or "") return [];
        var mapped = States.GetValueOrDefault(status, "pending");
        var error = S(row["error_Message"]);
        if (error.Length == 0) error = S(row["field9"]);
        return [new PaymentAttempt(S(row["mihpayid"]), mapped, MethodOf(S(row["mode"])), PaiseOf(row["amt"]), mapped == "failed" ? error : "")];
    }

    public async Task<RefundResult> RefundAsync(IntegrationSettings c, string paymentId, string reference, long amount, string currency, string refundId, string note)
    {
        var data = await Command(c, "cancel_refund_transaction", new() { ["var1"] = paymentId, ["var2"] = Cut(refundId, 40), ["var3"] = Rupees(amount) });
        if (S(data?["status"]) != "1")
            throw new PaymentGatewayException(Cut(S(data?["msg"]) is { Length: > 0 } m ? m : "PayU did not accept the refund", 300));
        var id = S(data?["request_id"]);
        return new RefundResult(id.Length > 0 ? id : refundId, "pending");
    }

    public async Task<string> RefundStatusAsync(IntegrationSettings c, string reference, string refundId, string providerRefundId)
    {
        if (providerRefundId.Length == 0) return "unknown";
        var data = await Command(c, "check_action_status", new() { ["var1"] = providerRefundId });
        var found = new List<string>();
        void Walk(JsonNode? node)  // the answer nests the refund under its request id and payment id
        {
            if (node is not JsonObject o) return;
            if (o["status"] is JsonValue sv && sv.TryGetValue<string>(out var st) && (o.ContainsKey("request_id") || o.ContainsKey("mihpayid") || o.ContainsKey("bank_ref_num")))
                found.Add(st.ToLowerInvariant());
            foreach (var kv in o) Walk(kv.Value);
        }
        Walk(data?["transaction_details"]);
        if (found.Count == 0) return "unknown";
        return found[0] == "success" ? "processed" : found[0] is "failure" or "failed" ? "failed" : "pending";
    }

    public string? VerifyWebhook(IntegrationSettings c, IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        if (c.PayuSalt.Length == 0) return null;
        var text = Encoding.UTF8.GetString(body);
        Dictionary<string, string> data;
        if (text.TrimStart().StartsWith('{'))
        {
            if (PaymentHttp.Parse(text) is not JsonObject o) return null;
            data = o.ToDictionary(kv => kv.Key, kv => S(kv.Value));
        }
        else
        {
            var q = System.Web.HttpUtility.ParseQueryString(text);
            data = q.AllKeys.Where(k => k is not null).ToDictionary(k => k!, k => q[k] ?? "");
        }
        var hash = data.GetValueOrDefault("hash", "");
        if (hash.Length == 0 || !SameText(ResponseHash(c.PayuSalt, data), hash.ToLowerInvariant())) return null;
        return data.GetValueOrDefault("txnid", "");
    }

    public string ReferenceFromReturn(IReadOnlyDictionary<string, string> data) => Cut(data.GetValueOrDefault("txnid", ""), 100);

    public async Task<string> TestAsync(IntegrationSettings c)
    {
        if (!Configured(c)) throw new PaymentGatewayException("Enter the merchant key and salt first.");
        var data = await Command(c, "verify_payment", new() { ["var1"] = "pixcart-connection-test" });
        var message = S(data?["msg"]);
        var lower = message.ToLowerInvariant();
        if (lower.Contains("invalid") || (lower.Contains("hash") && lower.Contains("mismatch"))) throw new PaymentGatewayException("PayU refused the keys: " + message);
        return $"Keys accepted ({(Sandbox(c) ? "sandbox" : "live")})";
    }
}

/// <summary>Stripe Checkout: sessions, payment intents, refunds and the signed webhook (Stripe-Signature).</summary>
public sealed class StripeGateway(PaymentHttp http) : IPaymentGateway
{
    public const int ToleranceSeconds = 300;

    public string Code => "stripe";
    public string Name => "Stripe";
    public string Mode => "redirect";
    public bool Configured(IntegrationSettings c) => c.StripeSecretKey.Length > 0;
    public bool SwitchedOn(IntegrationSettings c) => c.StripeCheckout;
    public IReadOnlySet<string>? Currencies(IntegrationSettings c) => null;
    public bool Sandbox(IntegrationSettings c) => !c.StripeSecretKey.Contains("_live_", StringComparison.Ordinal);
    public bool WebhookReady(IntegrationSettings c) => c.StripeWebhookSecret.Length > 0;
    private string Base(IntegrationSettings c) => (c.StripeApiBase.Length > 0 ? c.StripeApiBase : "https://api.stripe.com/v1").TrimEnd('/');

    private async Task<JsonNode?> Call(IntegrationSettings c, HttpMethod method, string path, Dictionary<string, string>? form = null, string idempotencyKey = "",
        CancellationToken ct = default)
    {
        if (!Configured(c)) throw new PaymentGatewayException("Stripe is not configured");
        var req = PaymentHttp.Form(method, Base(c) + path, form);
        req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + c.StripeSecretKey);
        if (idempotencyKey.Length > 0) req.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey); // a retried call returns the first call's result
        var (status, text) = await http.SendAsync("Stripe", req, 15, ct);
        if (status >= 400) throw new PaymentGatewayException(PaymentHttp.ErrorText(text, "error.message") is { Length: > 0 } e ? e : $"Stripe error ({status})");
        return PaymentHttp.Parse(text);
    }

    public async Task<CreatedPayment> CreateAsync(IntegrationSettings c, long amount, string currency, string receipt, PaymentCustomer customer,
        string returnUrl, string notifyUrl, CancellationToken ct = default)
    {
        var back = returnUrl + "?session_id={CHECKOUT_SESSION_ID}";
        var form = new Dictionary<string, string>
        {
            ["mode"] = "payment", ["success_url"] = back, ["cancel_url"] = back, ["client_reference_id"] = receipt, ["metadata[order_number]"] = receipt,
            ["line_items[0][quantity]"] = "1", ["line_items[0][price_data][currency]"] = currency.ToLowerInvariant(),
            ["line_items[0][price_data][unit_amount]"] = amount.ToString(CultureInfo.InvariantCulture), ["line_items[0][price_data][product_data][name]"] = $"Order {receipt}",
            ["payment_intent_data[metadata][order_number]"] = receipt,
        };
        if (customer.Email.Length > 0) form["customer_email"] = customer.Email;
        var data = await Call(c, HttpMethod.Post, "/checkout/sessions", form, ct: ct);
        var id = S(data?["id"]);
        var url = S(data?["url"]);
        if (id.Length == 0 || url.Length == 0) throw new PaymentGatewayException("Stripe did not return a checkout page");
        return new CreatedPayment(id, new JsonObject { ["url"] = url });
    }

    public async Task<IReadOnlyList<PaymentAttempt>> AttemptsAsync(IntegrationSettings c, string reference, CancellationToken ct = default)
    {
        var s = await Call(c, HttpMethod.Get, $"/checkout/sessions/{reference}?expand%5B%5D=payment_intent", ct: ct);
        var pi = s?["payment_intent"] as JsonObject;
        var pid = pi is not null ? S(pi["id"]) : s?["payment_intent"] is JsonValue v && v.TryGetValue<string>(out var sid) ? sid : "";
        var amount = L(s?["amount_total"]);
        var when = L(s?["created"]);
        if (S(s?["payment_status"]) == "paid") return [new PaymentAttempt(pid.Length > 0 ? pid : reference, "captured", "card", amount, "", when)];
        var error = S(pi?["last_payment_error"]?["message"]);
        if (S(s?["status"]) == "expired")
            return [new PaymentAttempt(pid.Length > 0 ? pid : reference, "failed", "card", amount, error.Length > 0 ? error : "The payment page expired", when)];
        if (error.Length > 0) return [new PaymentAttempt(pid, "failed", "card", amount, error, when)];
        if (pi is not null && S(pi["status"]) is "processing" or "requires_action") return [new PaymentAttempt(pid, "pending", "card", amount, "", when)];
        return [];
    }

    public async Task<RefundResult> RefundAsync(IntegrationSettings c, string paymentId, string reference, long amount, string currency, string refundId, string note)
    {
        var data = await Call(c, HttpMethod.Post, "/refunds",
            new() { ["payment_intent"] = paymentId, ["amount"] = amount.ToString(CultureInfo.InvariantCulture), ["metadata[refund_id]"] = refundId }, $"refund-{refundId}");
        return new RefundResult(S(data?["id"]), S(data?["status"]) == "succeeded" ? "processed" : "pending");
    }

    public async Task<string> RefundStatusAsync(IntegrationSettings c, string reference, string refundId, string providerRefundId)
    {
        if (providerRefundId.Length == 0) return "unknown"; // a retry is safe: refunds are sent with an idempotency key
        var status = S((await Call(c, HttpMethod.Get, $"/refunds/{providerRefundId}"))?["status"]);
        return status == "succeeded" ? "processed" : status is "failed" or "canceled" ? "failed" : "pending";
    }

    public string? VerifyWebhook(IntegrationSettings c, IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        var secret = c.StripeWebhookSecret;
        var header = headers.GetValueOrDefault("stripe-signature", "");
        if (secret.Length == 0 || header.Length == 0) return null;
        var parts = header.Split(',').Select(p => p.Split('=', 2)).Where(p => p.Length == 2).ToList();
        var stamp = parts.FirstOrDefault(p => p[0].Trim() == "t")?[1] ?? "";
        if (!long.TryParse(stamp, NumberStyles.None, CultureInfo.InvariantCulture, out var t) || Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - t) > ToleranceSeconds)
            return null;
        var expected = Hex(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(stamp + ".").Concat(body).ToArray()));
        if (!parts.Where(p => p[0].Trim() == "v1").Any(p => SameText(expected, p[1]))) return null;
        if (PaymentHttp.Parse(Encoding.UTF8.GetString(body)) is not JsonObject root) return null;
        var obj = root["data"]?["object"] as JsonObject;
        return S(obj?["object"]) switch
        {
            "checkout.session" or "payment_intent" => S(obj?["id"]),
            "charge" or "refund" => S(obj?["payment_intent"]), // the payment the refund belongs to
            _ => "", // a genuine event about something else: acknowledged, nothing to check
        };
    }

    public string ReferenceFromReturn(IReadOnlyDictionary<string, string> data) => Cut(data.GetValueOrDefault("session_id", ""), 100);

    public async Task<string> TestAsync(IntegrationSettings c)
    {
        if (!Configured(c)) throw new PaymentGatewayException("Enter the secret key first.");
        await Call(c, HttpMethod.Get, "/balance");
        return $"Keys accepted ({(Sandbox(c) ? "test" : "live")} mode)";
    }
}
