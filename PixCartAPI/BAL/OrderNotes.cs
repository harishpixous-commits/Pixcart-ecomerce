using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Private staff notes on an order (mirror of admin.py order notes). Customers and sellers never see them; notes are not edited or deleted.</summary>
public static class OrderNotes
{
    static JsonObject Out(Guid id, string note, string author, DateTime at) => new() { ["id"] = id.ToString(), ["note"] = note, ["author"] = author.Length > 0 ? author : "Staff", ["at"] = DateTime.SpecifyKind(at, DateTimeKind.Utc).ToString("o") };

    static async Task EnsureOrderAsync(IMySqlDapperHelper db, Guid orderId)
    {
        if (await db.QueryFirstOrDefaultAsync<int>("SELECT COUNT(*) FROM orders WHERE id = @orderId", new { orderId }) == 0) throw new NotFoundException("Order");
    }

    public static async Task<JsonObject> ListAsync(IMySqlDapperHelper db, Guid orderId)
    {
        await EnsureOrderAsync(db, orderId);
        var rows = await db.QueryAsync<(Guid Id, string Note, string Author, DateTime At)>("SELECT id AS Id, note AS Note, author_name AS Author, created_at AS At FROM order_notes WHERE order_id = @orderId ORDER BY created_at", new { orderId });
        return new JsonObject { ["items"] = new JsonArray(rows.Select(r => (JsonNode)Out(r.Id, r.Note, r.Author, r.At)).ToArray()) };
    }

    public static async Task<JsonObject> AddAsync(IMySqlDapperHelper db, UserModel admin, Guid orderId, string? note)
    {
        await EnsureOrderAsync(db, orderId);
        var text = string.Join(' ', (note ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (text.Length == 0) throw new AppException("Write a note", "invalid_note", 400);
        if (text.Length > 1000) throw new AppException("A note can be up to 1000 characters", "invalid_note", 422);
        if (await db.QueryFirstOrDefaultAsync<int>("SELECT COUNT(*) FROM order_notes WHERE order_id = @orderId", new { orderId }) >= 100) throw new AppException("This order already has 100 notes", "too_many_notes", 400);
        var id = Guid.NewGuid(); var now = DateTime.UtcNow;
        var author = (string.IsNullOrWhiteSpace(admin.Name) ? admin.Phone : admin.Name) ?? "";
        if (author.Length > 120) author = author[..120];
        await db.ExecuteAsync("INSERT INTO order_notes (id, order_id, author_id, author_name, note, created_at) VALUES (@id, @orderId, @by, @author, @text, @now)", new { id, orderId, by = admin.Id, author, text, now });
        await db.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (@by, 'order.note', 'order', @e, @d, UTC_TIMESTAMP(6), @aid)", new { by = admin.Id, e = orderId.ToString(), d = text.Length > 60 ? text[..60] : text, aid = Guid.NewGuid() });
        return Out(id, text, author, now);
    }
}
