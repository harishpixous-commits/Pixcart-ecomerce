using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using API.Service;
using BAL.Interface;
using Dapper;
using DAL.Helpers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using MySqlConnector;
using Utils;

[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace Tests.StorefrontCatalog;

/// <summary>
/// The API on a real MySQL test database (pixcart_test_catalog on 127.0.0.1:3307), with an in-memory Razorpay for
/// customers and tokens and a switchable fake AI for translations. Mirrors the reference tests' conftest.py.
/// </summary>
public sealed class CatalogFactory : WebApplicationFactory<Program>
{
    public const string Database = "pixcart_test_catalog";
    public static readonly string Server = Tests.TestMySql.Server; // TEST_MYSQL (CI) or the local server on 3307
    public static string ConnectionString => Server + $"Database={Database};";
    public static readonly string MediaRoot = Path.Combine(Path.GetTempPath(), "pixcart-test-catalog", "media");

    public FakeRazorpay Gateway { get; } = new();
    public FakeAi Ai { get; } = new();

    public CatalogFactory()
    {
        // Program reads the "App" section while the builder is created, so the settings go in as environment variables.
        var env = new Dictionary<string, string>
        {
            ["App__Environment"] = "test", ["App__ConnectionString"] = ConnectionString, ["App__RunJobs"] = "false",
            ["App__MediaRoot"] = MediaRoot, ["App__PrivateRoot"] = Path.Combine(Path.GetTempPath(), "pixcart-test-catalog", "private"),
            ["App__RazorpayKeyId"] = "rzp_test_key", ["App__RazorpayKeySecret"] = "rzp_test_secret", ["App__RazorpayApiBase"] = "https://api.razorpay.test/v1",
        };
        foreach (var (k, v) in env) Environment.SetEnvironmentVariable(k, v);
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureTestServices(services =>
        {
            services.AddHttpClient("razorpay").ConfigurePrimaryHttpMessageHandler(() => Gateway);
            // the fake AI replaces the real model-backed services (no model is connected in tests)
            services.RemoveAll<IAiAvailability>();
            services.RemoveAll<ITranslationEngine>();
            services.AddSingleton<IAiAvailability>(Ai);
            services.AddSingleton<ITranslationEngine>(Ai);
        });
    }

    private static bool _migrated;
    private static readonly SemaphoreSlim Gate = new(1, 1);

    /// <summary>A fresh database once per test run (dropped, then migrated with the embedded scripts).</summary>
    public static async Task EnsureDatabaseAsync()
    {
        await Gate.WaitAsync();
        try
        {
            if (_migrated) return;
            await using (var c = new MySqlConnection(Server))
            {
                await c.OpenAsync();
                await c.ExecuteAsync($"DROP DATABASE IF EXISTS `{Database}`");
            }
            await new DatabaseMigrator(new AppSettings { ConnectionString = ConnectionString }, NullLogger<DatabaseMigrator>.Instance).MigrateAsync();
            _migrated = true;
        }
        finally
        {
            Gate.Release();
        }
    }

    /// <summary>Empties every table (the reference tests' clean_db fixture).</summary>
    public static async Task CleanAsync()
    {
        await using var c = new MySqlConnection(ConnectionString);
        await c.OpenAsync();
        var tables = (await c.QueryAsync<string>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = @db AND table_name <> 'schema_versions' AND table_type = 'BASE TABLE'",
            new { db = Database })).ToList();
        var sql = new StringBuilder("SET FOREIGN_KEY_CHECKS = 0;");
        foreach (var t in tables) sql.Append($"DELETE FROM `{t}`;");
        sql.Append("SET FOREIGN_KEY_CHECKS = 1;");
        await c.ExecuteAsync(sql.ToString());
    }
}

/// <summary>Implements the Razorpay customer token endpoints the storefront uses, with real-shaped responses.</summary>
public sealed class FakeRazorpay : HttpMessageHandler
{
    public Dictionary<string, List<JsonObject>> Tokens { get; } = [];
    public string? FailNext { get; set; }

    public void Reset()
    {
        Tokens.Clear();
        FailNext = null;
    }

    public string AddCustomer()
    {
        var id = "cust_" + Guid.NewGuid().ToString("N")[..14];
        Tokens[id] = [];
        return id;
    }

    /// <summary>What happens when the shopper ticks "save this card" in Razorpay's window: a network token.</summary>
    public string SaveCard(string customerId, string last4 = "1111", string network = "Visa")
    {
        var tid = "token_" + Guid.NewGuid().ToString("N")[..14];
        Tokens[customerId].Add(new JsonObject
        {
            ["id"] = tid, ["entity"] = "token", ["method"] = "card", ["used_at"] = 1700000000,
            ["card"] = new JsonObject
            {
                ["last4"] = last4, ["network"] = network, ["type"] = "credit", ["issuer"] = "HDFC", ["expiry_month"] = 12, ["expiry_year"] = 2030, ["international"] = false,
            },
        });
        return tid;
    }

    private static HttpResponseMessage Json(int status, JsonNode body) =>
        new((HttpStatusCode)status) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var auth = request.Headers.Authorization;
        if (auth?.Scheme != "Basic" || auth.Parameter != Convert.ToBase64String(Encoding.UTF8.GetBytes("rzp_test_key:rzp_test_secret")))
            return Task.FromResult(Json(401, new JsonObject { ["error"] = new JsonObject { ["description"] = "auth" } }));
        if (FailNext != null)
        {
            var msg = FailNext;
            FailNext = null;
            return Task.FromResult(Json(502, new JsonObject { ["error"] = new JsonObject { ["description"] = msg } }));
        }
        var path = request.RequestUri!.AbsolutePath;
        if (path.StartsWith("/v1")) path = path[3..];
        var parts = path.Split('/');
        if (path.StartsWith("/customers/") && path.Contains("/tokens"))
        {
            var cid = parts[2];
            if (!Tokens.TryGetValue(cid, out var list))
                return Task.FromResult(Json(400, new JsonObject { ["error"] = new JsonObject { ["description"] = "The id provided does not exist" } }));
            if (request.Method == HttpMethod.Get)
                return Task.FromResult(Json(200, new JsonObject
                {
                    ["entity"] = "collection", ["count"] = list.Count, ["items"] = new JsonArray(list.Select(t => (JsonNode)t.DeepClone()).ToArray()),
                }));
            if (request.Method == HttpMethod.Delete)
            {
                list.RemoveAll(t => t["id"]!.GetValue<string>() == parts[4]);
                return Task.FromResult(Json(200, new JsonObject { ["deleted"] = true }));
            }
        }
        return Task.FromResult(Json(404, new JsonObject { ["error"] = new JsonObject { ["description"] = $"unhandled {request.Method} {path}" } }));
    }
}

/// <summary>A connected AI that translates by prefixing the language ("[ta] Hello"), switched on per test.</summary>
public sealed class FakeAi : IAiAvailability, ITranslationEngine
{
    public bool Ready { get; set; }

    public Task<bool> ConfiguredAsync(string route) => Task.FromResult(Ready);

    public Task<IReadOnlyDictionary<string, string>> TranslateAsync(string lang, string languageName, IReadOnlyList<string> texts) =>
        Task.FromResult<IReadOnlyDictionary<string, string>>(texts.ToDictionary(t => t, t => $"[{lang}] {t}"));
}

/// <summary>A response: status code and JSON body.</summary>
public sealed record Res(int Status, JsonNode? Body)
{
    public JsonNode this[string key] => Body![key]!;
    public string? ErrorCode => Body?["error"]?["code"]?.GetValue<string>();
}

/// <summary>A signed-in (or visitor) client.</summary>
public sealed class Api(HttpClient http, string? token, Guid userId)
{
    public Guid UserId { get; } = userId;

    private async Task<Res> SendAsync(HttpMethod method, string url, object? body = null)
    {
        using var req = new HttpRequestMessage(method, url);
        if (token != null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body != null)
            req.Content = new StringContent(body is JsonNode n ? n.ToJsonString() : JsonSerializer.Serialize(body, JsonHelper.Options), Encoding.UTF8, "application/json");
        using var resp = await http.SendAsync(req);
        var text = await resp.Content.ReadAsStringAsync();
        return new Res((int)resp.StatusCode, text.Length > 0 ? JsonNode.Parse(text) : null);
    }

    public Task<Res> Get(string url) => SendAsync(HttpMethod.Get, url);
    public Task<Res> Post(string url, object? body = null) => SendAsync(HttpMethod.Post, url, body ?? new { });
    public Task<Res> Put(string url, object body) => SendAsync(HttpMethod.Put, url, body);
    public Task<Res> Delete(string url) => SendAsync(HttpMethod.Delete, url);

    public async Task<Res> Upload(string url, byte[] data, string name, string contentType)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        if (token != null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(data);
        file.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        form.Add(file, "file", name);
        req.Content = form;
        using var resp = await http.SendAsync(req);
        var text = await resp.Content.ReadAsStringAsync();
        return new Res((int)resp.StatusCode, text.Length > 0 ? JsonNode.Parse(text) : null);
    }
}

[CollectionDefinition("catalog")]
public sealed class CatalogCollection : ICollectionFixture<CatalogFactory>;

/// <summary>Base of the storefront-catalog tests: a clean database per test and seeding helpers.</summary>
[Collection("catalog")]
public abstract class CatalogTestBase(CatalogFactory factory) : IAsyncLifetime
{
    protected CatalogFactory Factory { get; } = factory;
    protected HttpClient Http { get; } = factory.CreateClient();
    protected Api Visitor => new(Http, null, Guid.Empty);
    protected Seed Seed { get; } = new(factory);

    public async Task InitializeAsync()
    {
        await CatalogFactory.EnsureDatabaseAsync();
        await CatalogFactory.CleanAsync();
        Factory.Gateway.Reset();
        Factory.Ai.Ready = false;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    /// <summary>Runs code with a service from a fresh request scope (the way an admin endpoint would).</summary>
    protected async Task<T> With<TService, T>(Func<TService, Task<T>> f) where TService : notnull
    {
        await using var scope = Factory.Services.CreateAsyncScope();
        return await f(scope.ServiceProvider.GetRequiredService<TService>());
    }

    /// <summary>Admin → Marketplace settings (PUT /api/admin/settings is the admin module's endpoint; this is its BAL).</summary>
    protected Task<JsonObject> SetSettings(object changes) =>
        With<IPlatformSettingsBAL, JsonObject>(s => s.UpdateAsync(JsonNode.Parse(JsonSerializer.Serialize(changes, JsonHelper.Options))!.AsObject()));

    protected Task<JsonObject> SetReviewSettings(object changes) =>
        With<IReviewSettingsBAL, JsonObject>(s => s.UpdateAsync(JsonNode.Parse(JsonSerializer.Serialize(changes, JsonHelper.Options))!.AsObject()));

    protected async Task<Api> User(string phone, string name = "Test User", bool admin = false)
    {
        var id = await Seed.UserAsync(phone, name, admin);
        return new Api(Http, Factory.Services.GetRequiredService<TokenService>().CreateAccessToken(id, admin), id);
    }

    protected async Task<Api> Admin() => await User("9000000000", "Admin", admin: true);

    /// <summary>The reference tests' setup(): two sellers (Tamil Nadu, Karnataka), a shirt and a phone, both live.</summary>
    protected async Task<(S Tn, S Ka, P Shirt, P Phone, Dictionary<string, Guid> Cats)> SetupAsync()
    {
        var cats = await Seed.CategoriesAsync();
        var tn = await Seed.SellerAsync("9400000001", "Kovai Textiles", "33");
        var ka = await Seed.SellerAsync("9400000002", "Mysuru Mart", "29", "Mysuru", "570001");
        var shirt = await Seed.ProductAsync(tn, cats["shirts"], "Handloom Cotton Shirt Blue", [new("HL-1", 200000, 100000, 10)]);
        var phone = await Seed.ProductAsync(ka, cats["mobiles"], "Feature Phone Dual SIM", [new("FP-1", 150000, 120000, 10)]);
        return (tn, ka, shirt, phone, cats);
    }

    protected Task Sql(string sql, object? args = null) => Seed.ExecAsync(sql, args);

    protected Task<T?> Scalar<T>(string sql, object? args = null) => Seed.ScalarAsync<T>(sql, args);
}
