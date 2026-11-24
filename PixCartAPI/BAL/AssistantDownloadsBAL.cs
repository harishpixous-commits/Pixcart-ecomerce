using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using Model.DomainModel;
using Utils;
namespace BAL;

public partial class AssistantBAL
{
    private static JsonObject SavedMessage(AssistantMessageModel m) => new()
    {
        ["id"] = m.Id.ToString(), ["role"] = m.Role, ["text"] = m.Text,
        ["blocks"] = JsonNode.Parse(m.Blocks), ["status"] = m.Status, ["mode"] = m.Mode,
        ["created_at"] = m.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture) + (m.CreatedAt.Ticks % TimeSpan.TicksPerSecond == 0 ? "" : m.CreatedAt.ToString(".ffffff", CultureInfo.InvariantCulture)),
    };
    private static string SafeDownloadName(string title)
    {
        var name = Regex.Replace(title.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        return name.Length == 0 ? "assistant" : name[..Math.Min(50, name.Length)];
    }
    private static void CheckDownloadFormat(string format)
    {
        if (!AssistantDownloads.Formats.ContainsKey(format)) throw new NotFoundException("Format");
    }
    private async Task<AssistantDownload> BuildSavedAsync(string format, IReadOnlyList<JsonObject> messages, string title, string name)
    {
        var brand = (await site.GetSiteAsync())["brand_name"]?.GetValue<string>() ?? "";
        return new(AssistantDownloads.Build(format, messages, brand + " assistant \u2014 " + title, brand), AssistantDownloads.Formats[format], name);
    }
    public async Task<AssistantDownload> DownloadMessageAsync(UserModel user, Guid messageId, string format)
    {
        CheckDownloadFormat(format);
        var m = await dal.MessageAsync(messageId);
        var c = m is not null ? await dal.ConversationAsync(m.ConversationId) : null;
        if (m is null || c is null || c.UserId != user.Id) throw new NotFoundException("Message");
        var q = await dal.PriorQuestionAsync(c.Id, m.CreatedAt);
        var messages = new List<JsonObject>();
        if (q is not null && m.Role == "assistant") messages.Add(SavedMessage(q));
        messages.Add(SavedMessage(m));
        var name = SafeDownloadName(c.Title) + "-" + m.CreatedAt.ToString("yyyyMMdd-HHmm", CultureInfo.InvariantCulture) + "." + format;
        return await BuildSavedAsync(format, messages, c.Title, name);
    }
    public async Task<AssistantDownload> DownloadConversationAsync(UserModel user, Guid conversationId, string format)
    {
        CheckDownloadFormat(format);
        var c = await OwnAsync(user, conversationId);
        var messages = (await dal.MessagesAsync(c.Id)).Select(SavedMessage).ToList();
        return await BuildSavedAsync(format, messages, c.Title, SafeDownloadName(c.Title) + "." + format);
    }
}
