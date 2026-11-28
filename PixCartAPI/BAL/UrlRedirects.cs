using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>URL redirects: an old address mapped to a new one, used when the shop has no page there. Mirror of routers/redirects.py.</summary>
public static partial class UrlRedirects
{
    public record Input
    {
        public string FromPath { get; init; } = "";
        public string ToPath { get; init; } = "";
        public int StatusCode { get; init; } = 301;
        public bool IsActive { get; init; } = true;
    }
    sealed class Row { public Guid Id { get; set; } public string FromPath { get; set; } = ""; public string ToPath { get; set; } = ""; public int StatusCode { get; set; } public bool IsActive { get; set; } public int Hits { get; set; } }
    const string Cols = "id AS Id, from_path AS FromPath, to_path AS ToPath, status_code AS StatusCode, is_active AS IsActive, hits AS Hits";
    const int MaxRules = 500;
    static readonly string[] Reserved = ["/api", "/admin", "/seller", "/delivery", "/checkout"];

    [GeneratedRegex(@"^/[A-Za-z0-9\-_/.%]*$")] private static partial Regex FromOk();
    [GeneratedRegex(@"^(/(?!/)[A-Za-z0-9\-_/?=&.%#]*|https://[^\s""'<>]+)$")] private static partial Regex SafeHref();

    static AppException Bad(string message, string code) => new(message, code, 422);

    public static string NormFrom(string v)
    {
        v = (v ?? "").Trim(); var q = v.IndexOfAny(['?', '#']); if (q >= 0) v = v[..q];
        if (v.Length > 1) v = v.TrimEnd('/');
        return v.ToLowerInvariant();
    }

    static JsonObject Out(Row r) => new() { ["id"] = r.Id.ToString(), ["from_path"] = r.FromPath, ["to_path"] = r.ToPath, ["status_code"] = r.StatusCode, ["is_active"] = r.IsActive, ["hits"] = r.Hits };

    static async Task<(string Src, string Dst)> CheckAsync(IMySqlDapperHelper db, Input b, Guid? but)
    {
        var src = NormFrom(b.FromPath); var dst = (b.ToPath ?? "").Trim();
        if (src.Length is 0 or > 300 || dst.Length is 0 or > 500) throw Bad("An address is 1 to 300 characters (new address up to 500)", "validation_error");
        if (b.StatusCode is not (301 or 302)) throw Bad("Use 301 (permanent) or 302 (temporary)", "bad_status");
        if (!FromOk().IsMatch(src) || src == "/") throw Bad("The old address must start with / and look like /old-page", "bad_from");
        if (Reserved.Any(r => src.StartsWith(r, StringComparison.Ordinal))) throw Bad("Admin, seller, delivery, checkout and API addresses cannot be redirected", "reserved_from");
        if (!SafeHref().IsMatch(dst)) throw Bad("The new address must start with / or https://", "bad_to");
        if (NormFrom(dst) == src) throw Bad("The old and new address are the same", "same_address");
        if (dst.StartsWith('/'))
        {
            var from = NormFrom(dst);
            if (await db.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM url_redirects WHERE from_path = @from AND to_path IN (@src, @srcSlash) AND is_active = 1)", new { from, src, srcSlash = src + "/" }))
                throw Bad("That would send visitors in a circle with an existing redirect", "redirect_loop");
        }
        if (await db.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM url_redirects WHERE from_path = @src AND (@but IS NULL OR id <> @but))", new { src, but }))
            throw new AppException("There is already a redirect for that old address", "redirect_exists", 409);
        return (src, dst);
    }

    static Task AuditAsync(IMySqlDapperHelper db, UserModel admin, string action, string path) =>
        db.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (@by, @action, 'redirect', @path, '', UTC_TIMESTAMP(6), @aid)", new { by = admin.Id, action, path, aid = Guid.NewGuid() });

    public static async Task<JsonObject> AdminListAsync(IMySqlDapperHelper db)
    {
        var rows = await db.QueryAsync<Row>($"SELECT {Cols} FROM url_redirects ORDER BY from_path");
        return new JsonObject { ["items"] = new JsonArray(rows.Select(r => (JsonNode)Out(r)).ToArray()) };
    }

    public static async Task<JsonObject> CreateAsync(IMySqlDapperHelper db, UserModel admin, Input b)
    {
        if (await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM url_redirects") >= MaxRules) throw Bad($"You can keep up to {MaxRules} redirects. Delete old ones first.", "too_many");
        var (src, dst) = await CheckAsync(db, b, null);
        var id = Guid.NewGuid();
        await db.ExecuteAsync("INSERT INTO url_redirects (id, from_path, to_path, status_code, is_active) VALUES (@id, @src, @dst, @code, @active)", new { id, src, dst, code = b.StatusCode, active = b.IsActive });
        await AuditAsync(db, admin, "redirect.create", src);
        return Out((await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM url_redirects WHERE id = @id", new { id }))!);
    }

    public static async Task<JsonObject> EditAsync(IMySqlDapperHelper db, UserModel admin, Guid id, Input b)
    {
        _ = await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM url_redirects WHERE id = @id", new { id }) ?? throw new NotFoundException("Redirect");
        var (src, dst) = await CheckAsync(db, b, id);
        await db.ExecuteAsync("UPDATE url_redirects SET from_path=@src, to_path=@dst, status_code=@code, is_active=@active, updated_at=UTC_TIMESTAMP(6) WHERE id=@id", new { id, src, dst, code = b.StatusCode, active = b.IsActive });
        await AuditAsync(db, admin, "redirect.edit", src);
        return Out((await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM url_redirects WHERE id = @id", new { id }))!);
    }

    public static async Task<JsonObject> DeleteAsync(IMySqlDapperHelper db, UserModel admin, Guid id)
    {
        var cur = await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM url_redirects WHERE id = @id", new { id }) ?? throw new NotFoundException("Redirect");
        await db.ExecuteAsync("DELETE FROM url_redirects WHERE id = @id", new { id });
        await AuditAsync(db, admin, "redirect.delete", cur.FromPath);
        return new JsonObject { ["ok"] = true };
    }

    public static async Task<JsonObject> ResolveAsync(IMySqlDapperHelper db, string path)
    {
        var from = NormFrom(path);
        var r = await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM url_redirects WHERE from_path = @from AND is_active = 1", new { from }) ?? throw new NotFoundException("Redirect");
        await db.ExecuteAsync("UPDATE url_redirects SET hits = hits + 1 WHERE id = @id", new { id = r.Id });
        return new JsonObject { ["to"] = r.ToPath, ["status"] = r.StatusCode };
    }
}
