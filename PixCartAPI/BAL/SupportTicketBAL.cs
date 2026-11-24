using System.Security.Cryptography;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="ISupportTicketBAL"/>
public class SupportTicketBAL(SupportTicketDAL dal, IMySqlDapperHelper db) : ISupportTicketBAL
{
    public const int MaxOpen = 10;

    private static readonly Dictionary<string, string> CategoryLabels = new()
    {
        ["order"] = "A problem with an order",
        ["delivery"] = "Delivery or tracking",
        ["payment"] = "Payment or refund",
        ["return"] = "Return or replacement",
        ["product"] = "Product quality or listing",
        ["account"] = "My account",
        ["other"] = "Something else",
    };

    public IReadOnlyDictionary<string, string> Categories => CategoryLabels;

    public async Task<SupportTicketModel> CreateTicketAsync(UserModel user, string category, string subject, string message, Guid? orderId = null, bool isGrievance = false)
    {
        if (!CategoryLabels.ContainsKey(category)) throw new AppException("Choose what your request is about", "invalid_category");
        if (orderId is { } oid && await dal.OrderOwnerAsync(oid) != user.Id) throw new NotFoundException("Order");
        if (await dal.OpenCountAsync(user.Id) >= MaxOpen)
            throw new AppException($"You have {MaxOpen} open requests. Please wait for a reply on those first.", "too_many_tickets");
        var now = DateTimeFunctions.UtcNow();
        var t = new SupportTicketModel
        {
            Id = Guid.NewGuid(),
            Number = $"TK{now:yyMMdd}{Convert.ToHexString(RandomNumberGenerator.GetBytes(2))}",
            UserId = user.Id, OrderId = orderId, Category = category, Subject = subject.Trim(), Status = "open",
            IsGrievance = isGrievance, Priority = isGrievance ? "high" : "normal",
            // Consumer Protection (E-Commerce) Rules 2020: acknowledge within 48 hours, resolve within one month
            AckDueAt = now.AddHours(48), ResolveDueAt = now.AddDays(30), CreatedAt = now, UpdatedAt = now,
        };
        await using var uow = await db.BeginAsync();
        await dal.InsertAsync(t, uow.Transaction);
        await dal.InsertMessageAsync(new TicketMessageModel
        {
            Id = Guid.NewGuid(), TicketId = t.Id, AuthorId = user.Id, AuthorRole = "customer", Body = message.Trim(), CreatedAt = now,
        }, uow.Transaction);
        await uow.CommitAsync();
        return t;
    }

    public Dictionary<string, object?> TicketOut(SupportTicketModel t, IEnumerable<TicketMessageModel>? messages = null, bool staff = false)
    {
        var now = DateTimeFunctions.UtcNow();
        var data = new Dictionary<string, object?>
        {
            ["id"] = t.Id.ToString(), ["number"] = t.Number, ["category"] = t.Category, ["category_label"] = CategoryLabels.GetValueOrDefault(t.Category, t.Category),
            ["subject"] = t.Subject, ["status"] = t.Status, ["priority"] = t.Priority, ["is_grievance"] = t.IsGrievance,
            ["order_id"] = t.OrderId?.ToString(), ["created_at"] = DateTimeFunctions.Iso(t.CreatedAt), ["updated_at"] = DateTimeFunctions.Iso(t.UpdatedAt),
            ["acknowledged_at"] = DateTimeFunctions.Iso(t.AcknowledgedAt), ["resolved_at"] = DateTimeFunctions.Iso(t.ResolvedAt),
        };
        if (staff)
        {
            data["ack_due_at"] = DateTimeFunctions.Iso(t.AckDueAt);
            data["resolve_due_at"] = DateTimeFunctions.Iso(t.ResolveDueAt);
            data["ack_overdue"] = t.AcknowledgedAt is null && now > t.AckDueAt;
            data["resolve_overdue"] = t.Status is not ("resolved" or "closed") && now > t.ResolveDueAt;
            data["assigned_to"] = t.AssignedTo?.ToString();
        }
        if (messages is not null)
            data["messages"] = messages.Where(m => staff || !m.IsInternal).Select(m => new Dictionary<string, object?>
            {
                ["id"] = m.Id.ToString(), ["author_role"] = m.AuthorRole, ["body"] = m.Body, ["internal"] = m.IsInternal, ["at"] = DateTimeFunctions.Iso(m.CreatedAt),
            }).ToList();
        return data;
    }

    public async Task<object> MyTicketsAsync(UserModel user) => new { items = (await dal.ForUserAsync(user.Id, 100)).Select(t => TicketOut(t)).ToList() };

    private async Task<SupportTicketModel> OwnAsync(UserModel user, Guid id)
    {
        var t = await dal.GetAsync(id);
        if (t is null || t.UserId != user.Id) throw new NotFoundException("Request");
        return t;
    }

    public async Task<Dictionary<string, object?>> GetTicketAsync(UserModel user, Guid id)
    {
        var t = await OwnAsync(user, id);
        return TicketOut(t, await dal.MessagesAsync(t.Id));
    }

    public async Task<Dictionary<string, object?>> ReplyAsync(UserModel user, Guid id, string body)
    {
        await using (var uow = await db.BeginAsync())
        {
            var t = await dal.GetForUpdateAsync(id, uow.Transaction);
            if (t is null || t.UserId != user.Id) throw new NotFoundException("Request");
            if (t.Status == "closed") throw new ConflictException("This request is closed. Open a new one if you still need help.", "ticket_closed");
            var now = DateTimeFunctions.UtcNow();
            await dal.InsertMessageAsync(new TicketMessageModel
            {
                Id = Guid.NewGuid(), TicketId = t.Id, AuthorId = user.Id, AuthorRole = "customer", Body = body.Trim(), CreatedAt = now,
            }, uow.Transaction);
            t.Status = "open";
            t.UpdatedAt = now;
            await dal.UpdateStatusAsync(t, uow.Transaction);
            await uow.CommitAsync();
        }
        return await GetTicketAsync(user, id);
    }

    public async Task<Dictionary<string, object?>> CloseAsync(UserModel user, Guid id)
    {
        var t = await OwnAsync(user, id);
        t.Status = "closed";
        t.ResolvedAt ??= DateTimeFunctions.UtcNow();
        t.UpdatedAt = DateTimeFunctions.UtcNow();
        await dal.UpdateStatusAsync(t);
        return await GetTicketAsync(user, id);
    }
}
