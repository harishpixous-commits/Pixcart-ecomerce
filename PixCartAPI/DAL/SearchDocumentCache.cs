using System.Collections.Concurrent;
using Utils.TextSearch;

namespace DAL;

/// <summary>A product's search document with the slug, for one version of the product.</summary>
public sealed record SearchEntry(DateTime Version, string Slug, SearchDocument Document);

/// <summary>
/// Search documents of products, built once per product version (its updated_at, which every write of the title, brand
/// or description sets) and shared by all requests: a search reads only ids and versions of the products in scope and
/// the texts of products that are new or changed. Entries not used for <see cref="IdleLimit"/> are dropped.
/// Registered as a singleton.
/// </summary>
public sealed class SearchDocumentCache
{
    public static readonly TimeSpan IdleLimit = TimeSpan.FromMinutes(30);

    private sealed class Slot(SearchEntry entry)
    {
        public SearchEntry Entry = entry;
        public long LastUsed = Environment.TickCount64;
    }

    private readonly ConcurrentDictionary<Guid, Slot> slots = new();
    private long nextSweep = Environment.TickCount64 + (long)IdleLimit.TotalMilliseconds;

    public int Count => slots.Count;

    /// <summary>The cached entry when it is for this version of the product or a newer one.</summary>
    public SearchEntry? Get(Guid productId, DateTime version)
    {
        if (!slots.TryGetValue(productId, out var slot) || slot.Entry.Version < version) return null;
        slot.LastUsed = Environment.TickCount64;
        return slot.Entry;
    }

    /// <summary>Keeps the entry unless a newer version is already cached.</summary>
    public void Put(Guid productId, SearchEntry entry)
    {
        slots.AddOrUpdate(productId, _ => new Slot(entry), (_, old) => old.Entry.Version > entry.Version ? old : new Slot(entry));
        SweepIfDue();
    }

    private void SweepIfDue()
    {
        var now = Environment.TickCount64;
        var due = Interlocked.Read(ref nextSweep);
        if (now < due || Interlocked.CompareExchange(ref nextSweep, now + (long)IdleLimit.TotalMilliseconds, due) != due) return;
        var cutoff = now - (long)IdleLimit.TotalMilliseconds;
        foreach (var (id, slot) in slots)
            if (slot.LastUsed < cutoff) slots.TryRemove(new KeyValuePair<Guid, Slot>(id, slot));
    }
}
