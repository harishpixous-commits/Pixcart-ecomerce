using System.Text.Json.Nodes;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>Admin support desk (reference: routers/admin_extras.py ticket/staff_reply and
/// routers/customer.py ticket_out, services/support.py CATEGORIES).</summary>
public class SupportDeskBAL(IAccessBAL access, ICatalogNotifyBAL notify, IAiBAL ai, IMySqlDapperHelper db) : ISupportDeskBAL
{
    /// <summary>Reference: services/support.py CATEGORIES.</summary>
    private static readonly Dictionary<string, string> Categories = new()
    {
        ["order"] = "A problem with an order", ["delivery"] = "Delivery or tracking",
        ["payment"] = "Payment or refund", ["return"] = "Return or replacement",
        ["product"] = "Product quality or listing", ["account"] = "My account",
        ["other"] = "Something else",
    };

    /// <summary>Reference: ticket_out (staff view, with messages).</summary>
    internal static JsonObject TicketOut(SupportTicketModel t, List<TicketMessageModel>? msgs)
    {
        var now = DateTimeFunctions.UtcNow();
        var data = new JsonObject
        {
            ["id"] = t.Id.ToString(), ["number"] = t.Number, ["category"] = t.Category,
            ["category_label"] = Categories.GetValueOrDefault(t.Category, t.Category),
            ["subject"] = t.Subject, ["status"] = t.Status, ["priority"] = t.Priority,
            ["is_grievance"] = t.IsGrievance, ["order_id"] = t.OrderId?.ToString(),
            ["created_at"] = t.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["updated_at"] = t.UpdatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["acknowledged_at"] = t.AcknowledgedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["resolved_at"] = t.ResolvedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["ack_due_at"] = t.AckDueAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["resolve_due_at"] = t.ResolveDueAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["ack_overdue"] = t.AcknowledgedAt is null && now > t.AckDueAt,
            ["resolve_overdue"] = t.Status is not ("resolved" or "closed") && now > t.ResolveDueAt,
            ["assigned_to"] = t.AssignedTo?.ToString(),
            ["csat_rating"] = t.CsatRating, ["csat_comment"] = t.CsatComment ?? "",
            ["csat_at"] = t.CsatAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
        };
        if (msgs is not null)
            data["messages"] = new JsonArray(msgs.Select(m => (JsonNode)new JsonObject
            {
                ["id"] = m.Id.ToString(), ["author_role"] = m.AuthorRole, ["body"] = m.Body,
                ["internal"] = m.IsInternal, ["at"] = m.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            }).ToArray());
        return data;
    }

    /// <summary>How customers rated the handling of their requests: count, average, spread and the latest comments.</summary>
    public async Task<JsonObject> SatisfactionAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "support");
        var agg = await db.QueryFirstOrDefaultAsync<(long N, decimal? Avg)>("SELECT COUNT(*) AS N, AVG(csat_rating) AS Avg FROM support_tickets WHERE csat_rating IS NOT NULL");
        var spread = (await db.QueryAsync<(int R, long N)>("SELECT csat_rating AS R, COUNT(*) AS N FROM support_tickets WHERE csat_rating IS NOT NULL GROUP BY csat_rating")).ToDictionary(x => x.R, x => x.N);
        var unrated = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM support_tickets WHERE status IN ('resolved','closed') AND csat_rating IS NULL");
        var recent = (await db.QueryAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE csat_rating IS NOT NULL ORDER BY csat_at DESC LIMIT 10")).ToList();
        var sp = new JsonObject();
        for (var i = 1; i <= 5; i++) sp[i.ToString()] = spread.GetValueOrDefault(i);
        return new JsonObject
        {
            ["rated"] = agg.N, ["unrated_closed"] = unrated, ["average"] = agg.Avg is null ? null : Math.Round((double)agg.Avg.Value, 2), ["spread"] = sp,
            ["recent"] = new JsonArray(recent.Select(t => (JsonNode)new JsonObject
            {
                ["id"] = t.Id.ToString(), ["number"] = t.Number, ["subject"] = t.Subject, ["rating"] = t.CsatRating, ["comment"] = t.CsatComment,
                ["at"] = t.CsatAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            }).ToArray()),
        };
    }

    /// <summary>Reference: GET /api/admin/tickets/{ticket_id}.</summary>
    public async Task<JsonObject> GetAsync(UserModel admin, Guid ticketId)
    {
        await access.RequireAsync(admin, "support");
        var t = await db.QueryFirstOrDefaultAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE id = @ticketId", new { ticketId })
            ?? throw new NotFoundException("Ticket");
        var msgs = (await db.QueryAsync<TicketMessageModel>(
            "SELECT * FROM ticket_messages WHERE ticket_id = @ticketId ORDER BY created_at", new { ticketId })).ToList();
        var u = await db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @uid", new { uid = t.UserId })
            ?? throw new NotFoundException("User");
        var data = TicketOut(t, msgs);
        data["customer"] = new JsonObject { ["name"] = u.Name, ["phone"] = u.Phone, ["email"] = u.Email };
        data["order_number"] = t.OrderId is null
            ? null
            : await db.ExecuteScalarAsync<string?>("SELECT number FROM orders WHERE id = @oid", new { oid = t.OrderId });
        return data;
    }

    /// <summary>Reference: POST /api/admin/tickets/{ticket_id}/reply (staff_reply).</summary>
    public async Task<JsonObject> ReplyAsync(UserModel admin, Guid ticketId, string body, bool internalNote,
        string? status, string? priority, string? aiRunId)
    {
        await access.RequireAsync(admin, "support");
        body = body.Trim();
        await using var uow = await db.BeginAsync();
        var t = await uow.QueryFirstOrDefaultAsync<SupportTicketModel>(
            "SELECT * FROM support_tickets WHERE id = @ticketId FOR UPDATE", new { ticketId })
            ?? throw new NotFoundException("Ticket");
        var now = DateTimeFunctions.UtcNow();
        await uow.ExecuteAsync(
            "INSERT INTO ticket_messages (ticket_id, author_id, author_role, body, is_internal, created_at, id) " +
            "VALUES (@ticketId, @authorId, 'staff', @body, @isInternal, @now, @id)",
            new { ticketId = t.Id, authorId = admin.Id, body, isInternal = internalNote, now, id = Guid.NewGuid() });
        if (!internalNote)
        {
            t.AcknowledgedAt ??= now;
            t.Status = status ?? "awaiting_customer";
        }
        else if (status is not null)
        {
            t.Status = status;
        }
        if (priority is not null)
            t.Priority = priority;
        if (t.Status is "resolved" or "closed")
            t.ResolvedAt ??= now;
        t.AssignedTo ??= admin.Id;
        t.UpdatedAt = now;
        await uow.ExecuteAsync(
            "UPDATE support_tickets SET status = @Status, priority = @Priority, acknowledged_at = @AcknowledgedAt, " +
            "resolved_at = @ResolvedAt, assigned_to = @AssignedTo, updated_at = @UpdatedAt WHERE id = @Id", t);
        await uow.CommitAsync();
        // Notify after commit (ported pattern: CatalogNotifyBAL writes with its own connection, not this uow).
        if (!internalNote)
            await notify.NotifyUserAsync(t.UserId, "ticket_reply", new Dictionary<string, string>
            {
                ["ticket_number"] = t.Number, ["subject"] = t.Subject,
            }, link: $"/support/{t.Id}");
        if (aiRunId is not null && !internalNote)
            await ai.FinishAsync(aiRunId, "sent", admin, body);
        return await GetAsync(admin, ticketId);
    }
}
