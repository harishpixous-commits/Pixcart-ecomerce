using System.Security.Cryptography;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="ISupportBAL"/>
public class SupportBAL(SupportTicketDAL dal, IMySqlDapperHelper db) : ISupportBAL
{
    /// <summary>Reference: services/support.py CATEGORIES.</summary>
    public static readonly Dictionary<string, string> CategoryLabels = new()
    {
        ["order"] = "A problem with an order", ["delivery"] = "Delivery or tracking",
        ["payment"] = "Payment or refund", ["return"] = "Return or replacement",
        ["product"] = "Product quality or listing", ["account"] = "My account",
        ["other"] = "Something else",
    };

    public JsonObject Categories() => new()
    {
        ["categories"] = new JsonArray(CategoryLabels.Select(kv => (JsonNode)new JsonObject
        {
            ["code"] = kv.Key, ["label"] = kv.Value,
        }).ToArray()),
    };

    /// <summary>Reference: ticket_out (customer view; internal messages and staff-only fields hidden).</summary>
    private static JsonObject TicketOut(SupportTicketModel t, List<TicketMessageModel>? msgs)
    {
        var data = new JsonObject
        {
            ["id"] = t.Id.ToString(), ["number"] = t.Number, ["category"] = t.Category,
            ["category_label"] = CategoryLabels.GetValueOrDefault(t.Category, t.Category),
            ["subject"] = t.Subject, ["status"] = t.Status, ["priority"] = t.Priority,
            ["is_grievance"] = t.IsGrievance, ["order_id"] = t.OrderId?.ToString(),
            ["created_at"] = t.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["updated_at"] = t.UpdatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["acknowledged_at"] = t.AcknowledgedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["resolved_at"] = t.ResolvedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
        };
        if (msgs is not null)
            data["messages"] = new JsonArray(msgs.Where(m => !m.IsInternal).Select(m => (JsonNode)new JsonObject
            {
                ["id"] = m.Id.ToString(), ["author_role"] = m.AuthorRole, ["body"] = m.Body,
                ["internal"] = false, ["at"] = m.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            }).ToArray());
        return data;
    }

    public async Task<JsonObject> MyTicketsAsync(Guid userId)
    {
        var rows = await dal.ForUserAsync(userId, 100);
        return new JsonObject { ["items"] = new JsonArray(rows.Select(t => (JsonNode)TicketOut(t, null)).ToArray()) };
    }

    public async Task<JsonObject> OpenTicketAsync(Guid userId, string category, string subject, string message,
        Guid? orderId, bool isGrievance)
    {
        // Reference: create_ticket — category, order ownership and the 10-open-requests cap.
        if (!CategoryLabels.ContainsKey(category))
            throw new AppException("Choose what your request is about", "invalid_category");
        if (orderId is not null && await dal.OrderOwnerAsync(orderId.Value) != userId)
            throw new NotFoundException("Order");
        if (await dal.OpenCountAsync(userId) >= 10)
            throw new AppException("You have 10 open requests. Please wait for a reply on those first.", "too_many_tickets");
        var now = DateTimeFunctions.UtcNow();
        string number;
        do
        {
            number = $"TK{now:yyMMdd}{Convert.ToHexString(RandomNumberGenerator.GetBytes(2))}";
        } while (await dal.NumberExistsAsync(number));
        var t = new SupportTicketModel
        {
            Id = Guid.NewGuid(), Number = number, UserId = userId, OrderId = orderId, Category = category,
            Subject = subject.Trim(), Status = "open", Priority = isGrievance ? "high" : "normal",
            IsGrievance = isGrievance,
            // Consumer Protection (E-Commerce) Rules 2020: acknowledge within 48 hours, resolve within one month.
            AckDueAt = now.AddHours(48), ResolveDueAt = now.AddDays(30), CreatedAt = now, UpdatedAt = now,
        };
        await dal.InsertAsync(t);
        await dal.InsertMessageAsync(new TicketMessageModel
        {
            Id = Guid.NewGuid(), TicketId = t.Id, AuthorId = userId, AuthorRole = "customer",
            Body = message.Trim(), CreatedAt = now,
        });
        return TicketOut(t, []);
    }

    public async Task<JsonObject> GetTicketAsync(Guid userId, Guid ticketId)
    {
        var t = await dal.GetAsync(ticketId);
        if (t is null || t.UserId != userId) throw new NotFoundException("Request");
        var msgs = (await dal.MessagesAsync(t.Id)).ToList();
        return TicketOut(t, msgs);
    }

    public async Task<JsonObject> ReplyAsync(Guid userId, Guid ticketId, string body)
    {
        // Reference: reply_ticket — the ticket row is locked so a customer reply and a staff reply cannot interleave.
        await using var uow = await db.BeginAsync();
        var t = await dal.GetForUpdateAsync(ticketId, uow.Transaction);
        if (t is null || t.UserId != userId) throw new NotFoundException("Request");
        if (t.Status == "closed")
            throw new AppException("This request is closed. Open a new one if you still need help.", "ticket_closed");
        var now = DateTimeFunctions.UtcNow();
        await dal.InsertMessageAsync(new TicketMessageModel
        {
            Id = Guid.NewGuid(), TicketId = t.Id, AuthorId = userId, AuthorRole = "customer",
            Body = body.Trim(), CreatedAt = now,
        }, uow.Transaction);
        t.Status = "open";
        t.UpdatedAt = now;
        await dal.UpdateStatusAsync(t, uow.Transaction);
        await uow.CommitAsync();
        return await GetTicketAsync(userId, ticketId);
    }

    public async Task<JsonObject> CloseAsync(Guid userId, Guid ticketId)
    {
        var t = await dal.GetAsync(ticketId);
        if (t is null || t.UserId != userId) throw new NotFoundException("Request");
        t.Status = "closed";
        t.ResolvedAt ??= DateTimeFunctions.UtcNow();
        t.UpdatedAt = DateTimeFunctions.UtcNow();
        await dal.UpdateStatusAsync(t);
        return await GetTicketAsync(userId, ticketId);
    }
}
