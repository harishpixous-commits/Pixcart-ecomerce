using API.Configurations;

// PixCart Marketplace API (ASP.NET Core, .NET 10). Layout: API (Controllers, Configurations, Helpers, Infrastructure,
// Middleware, Service) → BAL (business rules, background workers) → DAL (MySQL with Dapper) → Model / Utils.
// See README.md for running it locally and on Windows (IIS).
var builder = WebApplication.CreateBuilder(args);
var settings = builder.AddPixCart();
var app = builder.Build();
if (await CommandLine.TryRunAsync(args, app.Services)) return; // dotnet API.dll create-admin | migrate
await app.UsePixCartAsync(settings);
app.Run();

/// <summary>Visible to the integration tests.</summary>
public partial class Program;
