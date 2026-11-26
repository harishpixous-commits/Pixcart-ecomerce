using Dapper;
using DAL.Helpers;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>The site's translations (one row per language and source line) and their counts.</summary>
public class RegionalDAL(IMySqlDapperHelper db)
{
    /// <summary>Saved translations of these source hashes: hash → text.</summary>
    public async Task<Dictionary<string, string>> LookupAsync(string lang, IEnumerable<string> hashes) =>
        (await db.QueryAsync<(string, string)>("SELECT source_hash, text FROM translations WHERE lang = @lang AND source_hash IN @hashes",
            new { lang, hashes = hashes.ToList() })).ToDictionary(r => r.Item1, r => r.Item2);

    /// <summary>AI lines added in the last day (all languages), for the daily limit.</summary>
    public async Task<long> AiUsedSinceAsync(DateTime since) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM translations WHERE origin = 'ai' AND created_at >= @since", new { since });

    /// <summary>
    /// Keeps translations: AI lines never replace existing ones; staff corrections ("manual") always do.
    /// Each row is (hash, source, text).
    /// </summary>
    public async Task SaveAsync(string lang, IEnumerable<(string Hash, string Source, string Text)> rows, string origin)
    {
        var now = DateTimeFunctions.UtcNow();
        foreach (var (hash, source, text) in rows)
        {
            var args = new { id = Guid.NewGuid(), lang, hash, source, text, origin, now };
            if (origin == "manual")
                await db.ExecuteAsync(
                    "INSERT INTO translations (id, lang, source_hash, source, text, origin, created_at, updated_at) VALUES (@id, @lang, @hash, @source, @text, @origin, @now, @now) " +
                    "ON DUPLICATE KEY UPDATE text = VALUES(text), origin = 'manual', updated_at = VALUES(updated_at)", args);
            else
                await db.ExecuteAsync(
                    "INSERT IGNORE INTO translations (id, lang, source_hash, source, text, origin, created_at, updated_at) VALUES (@id, @lang, @hash, @source, @text, @origin, @now, @now)", args);
        }
    }

    public async Task<Dictionary<string, long>> CountsByLangAsync() =>
        (await db.QueryAsync<(string, long)>("SELECT lang, COUNT(*) FROM translations GROUP BY lang")).ToDictionary(r => r.Item1, r => r.Item2);

    private static string Where(string lang, string q, string origin, DynamicParameters p)
    {
        var w = "lang = @lang";
        p.Add("lang", lang);
        if (q.Length > 0) { w += " AND (source LIKE @like OR text LIKE @like)"; p.Add("like", "%" + q + "%"); } // a pattern: % and _ match anything
        if (origin.Length > 0) { w += " AND origin = @origin"; p.Add("origin", origin); }
        return w;
    }

    public async Task<long> CountAsync(string lang, string q, string origin)
    {
        var p = new DynamicParameters();
        return await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM translations WHERE {Where(lang, q, origin, p)}", p);
    }

    public Task<IEnumerable<TranslationModel>> PageAsync(string lang, string q, string origin, int take, int skip)
    {
        var p = new DynamicParameters();
        var w = Where(lang, q, origin, p);
        p.Add("take", take);
        p.Add("skip", skip);
        return db.QueryAsync<TranslationModel>($"SELECT * FROM translations WHERE {w} ORDER BY source LIMIT @take OFFSET @skip", p);
    }

    /// <summary>Removes one line (by id), or every AI line of the language, or every line; returns how many.</summary>
    public Task<int> DeleteAsync(string lang, string id, bool onlyAi) =>
        db.ExecuteAsync("DELETE FROM translations WHERE lang = @lang" + (id.Length > 0 ? " AND id = @id" : onlyAi ? " AND origin = 'ai'" : ""), new { lang, id });
}
