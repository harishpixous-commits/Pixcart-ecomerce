using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using BAL;
using Model.DomainModel.Integrations;
using Utils;
using Xunit;

namespace PixCartAPI.Tests;

/// <summary>
/// Offline egress-guard proof: every gateway send goes through RazorpayBAL.TransportFactory in these tests,
/// so the recording handler sees each request; zero recorded requests means zero sockets were opened.
/// Covers the main payment paths, the auxiliary customer path, an omitted (unset) ExternalProviderMode,
/// and a redirect attempt from a loopback mock.
/// </summary>
[Collection("api")] // shares the static RazorpayBAL.TransportFactory with PaymentCallbackTests: never in parallel
public sealed class RazorpayEgressTests : IDisposable
{
    public RazorpayEgressTests() => RazorpayBAL.TransportFactory = () => Handler;
    public void Dispose() => RazorpayBAL.TransportFactory = null;

    private readonly RecordingHandler Handler = new();
    private readonly FakeHttpFactory HttpFactory = new();

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public readonly List<Uri> Requests = new();
        public HttpStatusCode Status = HttpStatusCode.OK;
        public string Body = "{}";
        public string? RedirectLocation;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri!);
            var resp = new HttpResponseMessage(Status) { Content = new StringContent(Body, Encoding.UTF8, "application/json") };
            if (RedirectLocation is not null) resp.Headers.Location = new Uri(RedirectLocation);
            return Task.FromResult(resp);
        }
    }

    private sealed class FakeHttpFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => throw new InvalidOperationException(
            "factory client must never be used while TransportFactory is set");
    }

    private sealed class FakeIntegrations : BAL.Interface.IIntegrationBAL
    {
        public Task<IntegrationSettings> GetAsync() => Task.FromResult(new IntegrationSettings
        {
            RazorpayKeyId = "mock_key",
            RazorpayKeySecret = "mock_secret",
        });
        public void Invalidate() { }
        public Task<List<Dictionary<string, object?>>> StatusAsync() => throw new NotImplementedException();
        public Task<List<string>> SaveAsync(string providerKey, JsonObject values, IReadOnlyList<string> clear, bool? enabled, string actorName) => throw new NotImplementedException();
        public Task<BAL.Interface.CheckResult> RunCheckAsync(string providerKey, IntegrationSettings cfg, IReadOnlyDictionary<string, string> parameters) => throw new NotImplementedException();
        public Task<JsonObject> RecordTestAsync(string providerKey, bool ok, string message) => throw new NotImplementedException();
        public Task<object> ListAsync() => throw new NotImplementedException();
        public Task<object> SaveFromAdminAsync(Model.DomainModel.UserModel admin, string key, JsonObject values, IReadOnlyList<string> clear, bool? enabled, string password, string totp) => throw new NotImplementedException();
        public Task<JsonObject> TestFromAdminAsync(Model.DomainModel.UserModel admin, string key, string phone, string to) => throw new NotImplementedException();
    }

    private RazorpayBAL Gateway(string apiBase, string mode = "") => new(
        new AppSettings { RazorpayApiBase = apiBase, ExternalProviderMode = mode },
        new FakeIntegrations(), HttpFactory);

    [Fact]
    public async Task Omitted_mode_fails_closed_no_send_main_path()
    {
        // ExternalProviderMode left unset ("") must NOT restore real provider access.
        var gw = Gateway("https://api.razorpay.com/v1");
        var ex = await Assert.ThrowsAsync<RazorpayBAL.GatewayException>(
            () => gw.CreateOrderAsync(39800, "rcpt", new Dictionary<string, string>()));
        Assert.Contains("restricted", ex.Message);
        Assert.Empty(Handler.Requests);
    }

    [Fact]
    public async Task Omitted_mode_fails_closed_no_send_auxiliary_customer_path()
    {
        var gw = Gateway("https://api.razorpay.com/v1");
        await Assert.ThrowsAsync<RazorpayBAL.GatewayException>(
            () => gw.CreateCustomerAsync("Test", "9000000000", "t@example.com"));
        Assert.Empty(Handler.Requests);
    }

    [Fact]
    public async Task Hostname_trick_is_blocked_no_send()
    {
        var gw = Gateway("http://127.0.0.1.evil.invalid:8599/v1");
        await Assert.ThrowsAsync<RazorpayBAL.GatewayException>(
            () => gw.FetchPaymentAsync("pay_MOCK1"));
        Assert.Empty(Handler.Requests);
    }

    [Fact]
    public async Task Loopback_base_sends_only_to_loopback()
    {
        Handler.Body = "{\"id\":\"order_1\"}";
        var gw = Gateway("http://127.0.0.1:8599/v1");
        await gw.CreateOrderAsync(39800, "rcpt", new Dictionary<string, string>());
        Assert.Single(Handler.Requests);
        Assert.Equal("127.0.0.1", Handler.Requests[0].Host);
    }

    [Fact]
    public async Task Redirect_from_loopback_mock_is_not_followed()
    {
        // Mock answers 302 to a non-loopback address; the client must not re-send there.
        Handler.Status = HttpStatusCode.Redirect;
        Handler.RedirectLocation = "http://10.255.255.1/steal";
        Handler.Body = "{}";
        var gw = Gateway("http://127.0.0.1:8599/v1");
        await gw.CreateOrderAsync(39800, "rcpt", new Dictionary<string, string>());
        Assert.Single(Handler.Requests);
        Assert.Equal("127.0.0.1", Handler.Requests[0].Host);
    }

    [Fact]
    public async Task Open_mode_uses_factory_transport_for_recording()
    {
        // Production semantics are explicit: only mode "open" is unrestricted, and the base is then whatever is configured.
        Handler.Body = "{\"id\":\"pay_1\",\"order_id\":\"order_TEST123\",\"status\":\"authorized\",\"method\":\"upi\",\"amount\":39800}";
        var gw = Gateway("https://api.razorpay.com/v1", mode: "open");
        await gw.FetchPaymentAsync("pay_1");
        Assert.Single(Handler.Requests);
        Assert.Equal("api.razorpay.com", Handler.Requests[0].Host);
    }
}
