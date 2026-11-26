using System.ComponentModel.DataAnnotations;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel;

namespace API.Controllers;

/// <summary>Admin - shop assistant: settings, help knowledge base, customer chats and stats (reference: routers/admin_shop_assistant.py).</summary>
[ApiController]
[Route("/api/admin/shop-assistant")]
public class AdminShopAssistantController(BAL.ShopAssistantBAL bal, ICurrentUser current) : ControllerBase
{
    /// <summary>Settings, feature switches and the mode/usage status card (reference: GET /settings).</summary>
    [HttpGet("settings")]
    public async Task<JsonResult> GetSettings() =>
        new(await bal.AdminGetSettingsAsync(await current.RequireAsync()));

    /// <summary>Validate and save the settings (reference: PUT /settings; errors carry code invalid_settings).</summary>
    [HttpPut("settings")]
    [Consumes("application/json")]
    public async Task<JsonResult> PutSettings([FromBody] System.Text.Json.Nodes.JsonObject body) =>
        new(await bal.AdminPutSettingsAsync(await current.RequireAsync(), body));

    public sealed record ArticleIn(
        [Required, StringLength(160, MinimumLength = 3)] string Title,
        [Required, StringLength(5000, MinimumLength = 10)] string Body,
        [param: MaxLength(40)] List<string>? Keywords,
        string Topic = "other",
        [param: StringLength(300)] string Link = "",
        bool IsPublished = true,
        [param: Range(0, 10000)] int Position = 0);

    /// <summary>All help articles plus topics and placeholders (reference: GET /articles; seeds the starter set first).</summary>
    [HttpGet("articles")]
    public async Task<JsonResult> ListArticles() =>
        new(await bal.AdminListArticlesAsync(await current.RequireAsync()));

    /// <summary>Create an article (reference: POST /articles, 201).</summary>
    [HttpPost("articles")]
    [Consumes("application/json")]
    public async Task<IActionResult> CreateArticle([FromBody] ArticleIn body)
    {
        var a = await bal.AdminCreateArticleAsync(await current.RequireAsync(), body.Title, body.Body,
            body.Keywords ?? [], body.Topic, body.Link, body.IsPublished, body.Position);
        return StatusCode(201, a);
    }

    /// <summary>Update an article (reference: PUT /articles/{article_id}).</summary>
    [HttpPut("articles/{articleId}")]
    [Consumes("application/json")]
    public async Task<JsonResult> UpdateArticle(Guid articleId, [FromBody] ArticleIn body) =>
        new(await bal.AdminUpdateArticleAsync(await current.RequireAsync(), articleId, body.Title, body.Body,
            body.Keywords ?? [], body.Topic, body.Link, body.IsPublished, body.Position));

    /// <summary>Delete an article (reference: DELETE /articles/{article_id}).</summary>
    [HttpDelete("articles/{articleId}")]
    public async Task<JsonResult> DeleteArticle(Guid articleId) =>
        new(await bal.AdminDeleteArticleAsync(await current.RequireAsync(), articleId));

    public sealed record TryIn([Required, StringLength(300, MinimumLength = 2)] string Question);

    /// <summary>Shows which published articles a customer question would find (reference: POST /articles/try).</summary>
    [HttpPost("articles/try")]
    [Consumes("application/json")]
    public async Task<JsonResult> TryQuestion([FromBody] TryIn body) =>
        new(await bal.AdminTryQuestionAsync(await current.RequireAsync(), body.Question));

    /// <summary>Customer chats with filters and masking (reference: GET /chats).</summary>
    [HttpGet("chats")]
    public async Task<JsonResult> ListChats([FromQuery, Range(1, 500)] int page = 1,
        [FromQuery, Range(-1, 1)] int? feedback = null, [FromQuery] bool escalated = false,
        [FromQuery, StringLength(80)] string q = "") =>
        new(await bal.AdminListChatsAsync(await current.RequireAsync(), page, feedback, escalated, q));

    /// <summary>One customer chat with its messages (reference: GET /chats/{chat_id}; audited).</summary>
    [HttpGet("chats/{chatId}")]
    public async Task<JsonResult> GetChat(Guid chatId) =>
        new(await bal.AdminGetChatAsync(await current.RequireAsync(), chatId));

    /// <summary>Usage statistics (reference: GET /stats).</summary>
    [HttpGet("stats")]
    public async Task<JsonResult> Stats([FromQuery, Range(1, 365)] int days = 30) =>
        new(await bal.AdminStatsAsync(await current.RequireAsync(), days));
}
