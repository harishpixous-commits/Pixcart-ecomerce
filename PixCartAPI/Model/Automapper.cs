using Mapster;

namespace Model;

/// <summary>
/// Object mapping rules (Mapster: same idea as AutoMapper, free and without its known security advisories).
/// Add a mapping here when a domain model and an API shape differ; same-named properties map without any rule.
/// Usage: <c>row.Adapt&lt;ProductCardDto&gt;()</c>.
/// </summary>
public static class Automapper
{
    private static bool _done;

    public static void Configure()
    {
        if (_done) return;
        _done = true;
        TypeAdapterConfig.GlobalSettings.Default.PreserveReference(false);
        TypeAdapterConfig.GlobalSettings.Default.IgnoreNullValues(false);
        // module mappings are registered by each module's static Register() method (see Model/DomainModel/*Mapper.cs)
        foreach (var t in typeof(Automapper).Assembly.GetTypes().Where(t => t.Name.EndsWith("Mapper") && t.IsClass && t.IsAbstract && t.IsSealed))
            t.GetMethod("Register")?.Invoke(null, null);
    }
}
