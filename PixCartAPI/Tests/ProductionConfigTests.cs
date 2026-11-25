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
    }

    [Fact]
    public void Production_starts_with_real_secrets_and_other_environments_are_not_checked()
    {
        new AppSettings
        {
            Environment = "production", JwtSecret = new string('x', 64), CookieSecure = true,
            FieldEncryptionKey = "x5W6CK2y8VnFZbBHt0b5n5lW2b3aX4m3rKk6Jm1o0rE=",
        }.ValidateForProduction();
        new AppSettings { Environment = "development" }.ValidateForProduction();
    }
}
