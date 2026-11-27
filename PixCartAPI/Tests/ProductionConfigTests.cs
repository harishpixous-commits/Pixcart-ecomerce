using Utils;

namespace Tests;

/// <summary>Ported from the reference Settings.validate_for_production: production never runs on the development secrets.</summary>
public class ProductionConfigTests
{
    [Fact]
    public void Production_refuses_the_development_secrets_and_insecure_cookies()
    {
        var s = new AppSettings { Environment = "production" };
        var e = Assert.Throws<InvalidOperationException>(s.ValidateForProduction);
        Assert.Contains("App__JwtSecret", e.Message);
        Assert.Contains("App__FieldEncryptionKey", e.Message);
        Assert.Contains("App__CookieSecure", e.Message);
        Assert.Contains("App__ExternalProviderMode", e.Message);
    }

    [Fact]
    public void Production_starts_with_real_secrets_and_other_environments_are_not_checked()
    {
        new AppSettings
        {
            Environment = "production", JwtSecret = new string('x', 64), CookieSecure = true,
            FieldEncryptionKey = "x5W6CK2y8VnFZbBHt0b5n5lW2b3aX4m3rKk6Jm1o0rE=", ExternalProviderMode = "open",
        }.ValidateForProduction();
        new AppSettings { Environment = "development" }.ValidateForProduction();
    }

    [Fact]
    public void Production_needs_provider_access_switched_on()
    {
        var s = new AppSettings
        {
            Environment = "production", JwtSecret = new string('x', 64), CookieSecure = true,
            FieldEncryptionKey = "x5W6CK2y8VnFZbBHt0b5n5lW2b3aX4m3rKk6Jm1o0rE=",
        };
        var e = Assert.Throws<InvalidOperationException>(s.ValidateForProduction);
        Assert.Contains("App__ExternalProviderMode", e.Message);
        Assert.DoesNotContain("App__JwtSecret", e.Message);
    }

    [Fact]
    public void The_hosting_package_switches_provider_access_on()
    {
        // the IIS settings that ship in the package (one-site hosting): production environment and real providers
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "API", "web.config"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var config = System.Xml.Linq.XDocument.Load(Path.Combine(dir!.FullName, "API", "web.config"));
        var vars = config.Descendants("environmentVariable").ToDictionary(v => (string)v.Attribute("name")!, v => (string)v.Attribute("value")!);
        Assert.Equal("production", vars["App__Environment"]);
        Assert.Equal("open", vars["App__ExternalProviderMode"]);
    }
}
