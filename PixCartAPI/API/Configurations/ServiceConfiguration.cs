using System.Reflection;
using API.Middleware;
using API.Service;
using BAL.Interface;
using DAL.Helpers;
using Microsoft.AspNetCore.Mvc;
using Microsoft.OpenApi;
using Model;
using Utils;
using Utils.Interface;

namespace API.Configurations;

/// <summary>
/// Everything the API registers: settings, Utils helpers, every DAL and BAL class (found by name, so a new module needs
/// no change here), background workers, JSON in the reference API's format, CORS, Swagger.
/// </summary>
public static class ServiceConfiguration
{
    public static AppSettings AddPixCart(this WebApplicationBuilder builder)
    {
        var settings = builder.Configuration.GetSection("App").Get<AppSettings>() ?? new AppSettings();
        var services = builder.Services;
        services.AddSingleton(settings);
        services.AddHttpContextAccessor();
        services.AddHttpClient();
        services.AddMemoryCache();

        // Utils (company helpers)
        services.AddSingleton<IMySqlDapperHelper, MySqlDapperHelper>();
        services.AddSingleton<IMySqlHelper, Utils.MySqlHelper>();
        services.AddSingleton<IMailHelper, MailHelper>();
        services.AddSingleton<ISMSHelper, SMSHelper>();
        services.AddSingleton<IFTPHelpers, FTPHelpers>();
        services.AddSingleton<IImageUpload, ImageUpload>();
        services.AddSingleton<EncryptDecrypt>();
        services.AddSingleton<DatabaseMigrator>();
        services.AddSingleton<TokenService>();
        services.AddScoped<ICurrentUser, CurrentUserService>();
        Automapper.Configure();

        // every *DAL class (scoped), and every *BAL class under its I*BAL interface when it has one
        RegisterByName(services, typeof(DAL.SettingsDAL).Assembly, "DAL");
        RegisterByName(services, typeof(BAL.AccessBAL).Assembly, "BAL");
        services.AddScoped<IRazorpayClient, BAL.RazorpayClient>(); // customers and saved-card tokens (payments may replace it)

        // background workers (BAL/BackgroundWorkerService): scheduled jobs, notifications, refunds ...
        if (settings.RunJobs && !settings.IsTest)
        {
            foreach (var t in typeof(BAL.AccessBAL).Assembly.GetTypes()
                         .Where(t => t is { IsClass: true, IsAbstract: false } && typeof(IHostedService).IsAssignableFrom(t)))
                services.AddSingleton(typeof(IHostedService), t);
        }

        services.AddControllers(o => o.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true)
            .AddJsonOptions(o =>
            {
                var j = JsonHelper.Options;
                o.JsonSerializerOptions.PropertyNamingPolicy = j.PropertyNamingPolicy;
                o.JsonSerializerOptions.DictionaryKeyPolicy = j.DictionaryKeyPolicy;
                o.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
            })
            .ConfigureApiBehaviorOptions(o => o.InvalidModelStateResponseFactory = ValidationResponse);

        services.AddCors(o => o.AddDefaultPolicy(p => p
            .WithOrigins(settings.CorsOriginList.ToArray())
            .AllowCredentials()
            .WithMethods("GET", "POST", "PUT", "PATCH", "DELETE")
            .WithHeaders("Authorization", "Content-Type", "X-Requested-With", "X-Request-ID", "X-Chat-Key")));

        services.AddEndpointsApiExplorer();
        services.AddSwaggerGen(o =>
        {
            o.SwaggerDoc("v1", new OpenApiInfo { Title = $"{settings.AppName} Marketplace API", Version = "1.0" });
            o.CustomSchemaIds(t => t.FullName?.Replace('+', '.'));
        });
        return settings;
    }

    private static void RegisterByName(IServiceCollection services, Assembly asm, string suffix)
    {
        foreach (var t in asm.GetTypes().Where(t => t is { IsClass: true, IsAbstract: false, IsGenericType: false } && t.Name.EndsWith(suffix)))
        {
            var iface = t.GetInterfaces().FirstOrDefault(i => i.Name == "I" + t.Name);
            if (iface != null) services.AddScoped(iface, t);
            services.AddScoped(t);
        }
    }

    // ---------------------------------------------------------------- validation errors in plain words

    private static readonly Dictionary<string, string> FieldLabels = new()
    {
        ["hsn_code"] = "HSN code", ["gst_bps"] = "GST rate", ["gstin"] = "GSTIN", ["pan"] = "PAN", ["ifsc"] = "IFSC", ["upi"] = "UPI ID", ["sku"] = "SKU",
        ["mrp_paise"] = "MRP", ["price_paise"] = "Selling price", ["qty"] = "Quantity", ["pincode"] = "PIN code", ["phone"] = "Mobile number",
        ["email"] = "Email", ["otp"] = "Code", ["code"] = "Code", ["line1"] = "Address", ["state_code"] = "State", ["vehicle_no"] = "Vehicle number",
    };

    private static IActionResult ValidationResponse(ActionContext ctx)
    {
        var fields = new Dictionary<string, string>();
        foreach (var (key, entry) in ctx.ModelState)
        {
            if (entry.Errors.Count == 0) continue;
            var name = ToSnake(key.Replace("$.", "").Replace("body.", ""));
            var msg = entry.Errors[0].ErrorMessage;
            if (string.IsNullOrWhiteSpace(msg)) msg = "is not valid";
            fields[string.IsNullOrEmpty(name) ? "_" : name] = msg;
        }
        var first = fields.FirstOrDefault();
        var last = first.Key?.Split('.').LastOrDefault(p => !p.All(char.IsDigit)) ?? "";
        var label = FieldLabels.TryGetValue(last, out var l) ? l : (last.Replace('_', ' ').Trim() is { Length: > 0 } s ? char.ToUpper(s[0]) + s[1..] : "Input");
        var message = first.Key is null or "_" ? (first.Value ?? "Invalid input") : $"{label}: {first.Value}";
        return new ObjectResult(new { error = new { code = "validation_error", message, fields } }) { StatusCode = 422 };
    }

    private static string ToSnake(string s) =>
        string.Concat(s.Select((c, i) => char.IsUpper(c) ? (i > 0 && s[i - 1] != '.' ? "_" : "") + char.ToLowerInvariant(c) : c.ToString()));

    // ---------------------------------------------------------------- pipeline

    public static async Task UsePixCartAsync(this WebApplication app, AppSettings settings)
    {
        if (!settings.IsTest) await app.Services.GetRequiredService<DatabaseMigrator>().MigrateAsync();
        app.UseMiddleware<RequestContextMiddleware>();
        app.UseMiddleware<ExceptionMiddleware>();
        if (!settings.IsProduction)
        {
            app.UseSwagger(o => o.RouteTemplate = "api/docs/{documentName}/swagger.json");
            app.UseSwaggerUI(o => { o.RoutePrefix = "api/docs"; o.SwaggerEndpoint("/api/docs/v1/swagger.json", "PixCart API"); });
        }
        // public images (local storage); product photos are immutable (new uploads get new names)
        var media = Path.GetFullPath(settings.MediaRoot);
        Directory.CreateDirectory(media);
        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(media),
            RequestPath = settings.MediaBaseUrl,
            OnPrepareResponse = c => c.Context.Response.Headers.CacheControl = "public, max-age=31536000, immutable",
        });
        app.UseCors();
        app.MapControllers();
    }
}
