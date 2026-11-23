namespace BAL.Interface;

// Optional services other modules provide to the storefront. Each is resolved as IEnumerable<T>: when no module has
// registered one yet, the storefront simply goes without (no deal timer sync, no sponsored products, no AI).
// Register an implementation with services.AddScoped<IDealSync, DealsBAL>() (or similar) in that module.

/// <summary>Starts due deals and ends finished ones (the promotions module). Returns how many deals changed.</summary>
public interface IDealSync
{
    Task<int> SyncAsync(bool force = false);
}

/// <summary>Sponsored products (the advertising module): records impressions and returns signed click tokens.</summary>
public interface ISponsoredProducts
{
    /// <summary>Products to show as "Sponsored" in a placement ("search", "product", "home") with the click token for each, best first.</summary>
    Task<IReadOnlyList<(Guid ProductId, string Token)>> ServeAsync(string placement, string visitor, string ip, string query, int limit);
}

/// <summary>Whether an AI model is connected for a route ("studio", "translate"), from the AI providers module.</summary>
public interface IAiAvailability
{
    Task<bool> ConfiguredAsync(string route);
}

/// <summary>Translates interface lines with the AI ("translate" route). Returns source → translation for the lines it could do.</summary>
public interface ITranslationEngine
{
    Task<IReadOnlyDictionary<string, string>> TranslateAsync(string lang, string languageName, IReadOnlyList<string> texts);
}
