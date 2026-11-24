using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>
/// Product Q&A, back-in-stock alerts, comparison and "Frequently bought together" (reference: routers/engagement.py —
/// same paths, bodies and payload).
/// </summary>
[ApiController]
public class EngagementController(IEngagementBAL engagement, ICurrentUser current) : ControllerBase
{
    public sealed record QuestionIn([param: Required, StringLength(500, MinimumLength = 10)] string Text);

    public sealed record AnswerIn([param: Required, StringLength(1000, MinimumLength = 2)] string Text);

    /// <summary>Reference QaReportIn: which kind of post and its id.</summary>
    public sealed record QaReportIn(
        [param: Required, RegularExpression("^(question|answer)$", ErrorMessage = "kind must be question or answer")] string Kind,
        [param: Required] Guid Id);

    public sealed record AlertIn([param: Required] Guid VariantId);

    [HttpGet("/api/catalog/products/{slug}/questions")]
    public async Task<JsonObject> Questions(
        string slug,
        [FromQuery, StringLength(80)] string q = "",
        [FromQuery, RegularExpression("^(helpful|recent)$", ErrorMessage = "sort must be helpful or recent")] string sort = "helpful",
        [FromQuery, Range(1, 200)] int page = 1) =>
        await engagement.QuestionsAsync(await current.GetAsync(), slug, q, sort, page);

    [HttpPost("/api/catalog/products/{slug}/questions")]
    [SignedIn]
    public async Task<IActionResult> Ask(string slug, QuestionIn body)
    {
        var result = await engagement.AskAsync(await User(), slug, body.Text);
        return StatusCode(201, result);
    }

    [HttpPost("/api/questions/{questionId:guid}/answers")]
    [SignedIn]
    public async Task<IActionResult> Answer(Guid questionId, AnswerIn body)
    {
        var result = await engagement.AnswerAsync(await User(), questionId, body.Text);
        return StatusCode(201, result);
    }

    [HttpPost("/api/answers/{answerId:guid}/helpful")]
    [SignedIn]
    public async Task<JsonObject> AnswerHelpful(Guid answerId) => await engagement.AnswerHelpfulAsync(await User(), answerId);

    [HttpPost("/api/qa/report")]
    [SignedIn]
    public async Task<JsonObject> Report(QaReportIn body) => await engagement.ReportAsync(await User(), body.Kind == "question", body.Id);

    [HttpPost("/api/alerts/stock")]
    [SignedIn]
    public async Task<IActionResult> StockAlertOn(AlertIn body)
    {
        var result = await engagement.StockAlertOnAsync(await User(), body.VariantId);
        return StatusCode(201, result);
    }

    [HttpDelete("/api/alerts/stock/{variantId:guid}")]
    [SignedIn]
    public async Task<JsonObject> StockAlertOff(Guid variantId) => await engagement.StockAlertOffAsync(await User(), variantId);

    [HttpGet("/api/alerts")]
    [SignedIn]
    public async Task<JsonObject> MyAlerts([FromQuery] Guid? variantId = null) => await engagement.MyAlertsAsync(await User(), variantId);

    [HttpGet("/api/catalog/compare")]
    public async Task<JsonObject> Compare([FromQuery, StringLength(200)] string ids = "") => await engagement.CompareAsync(ids);

    [HttpGet("/api/catalog/products/{slug}/bought-together")]
    public async Task<JsonObject> BoughtTogether(string slug) => await engagement.BoughtTogetherAsync(slug);

    [HttpGet("/api/seller/questions")]
    [SignedIn]
    public async Task<JsonObject> SellerQuestions([FromQuery] bool unanswered = false, [FromQuery, Range(1, int.MaxValue)] int page = 1) =>
        await engagement.SellerQuestionsAsync(await User(), unanswered, page);

    /// <summary>Small counts for the seller hub menu.</summary>
    [HttpGet("/api/seller/badges")]
    [SignedIn]
    public async Task<JsonObject> SellerBadges() => await engagement.SellerBadgesAsync(await User());

    [HttpPost("/api/seller/questions/{questionId:guid}/answer")]
    [SignedIn]
    public async Task<IActionResult> SellerAnswer(Guid questionId, AnswerIn body)
    {
        var result = await engagement.SellerAnswerAsync(await User(), questionId, body.Text);
        return StatusCode(201, result);
    }

    /// <summary>Questions and answers in one moderation queue.</summary>
    [HttpGet("/api/admin/questions")]
    [SignedIn]
    public async Task<JsonObject> AdminQueue(
        [FromQuery, RegularExpression("^(pending|published|hidden)$", ErrorMessage = "status must be pending, published or hidden")] string status = "pending",
        [FromQuery, StringLength(80)] string q = "",
        [FromQuery, Range(1, int.MaxValue)] int page = 1) =>
        await engagement.AdminQueueAsync(await User(), status, q, page);

    [HttpPost("/api/admin/questions/{kind}/{postId:guid}/{qaAction}")]
    [SignedIn]
    public async Task<JsonObject> AdminAction(
        [RegularExpression("^(question|answer)$", ErrorMessage = "kind must be question or answer")] string kind,
        Guid postId,
        [RegularExpression("^(publish|hide)$", ErrorMessage = "action must be publish or hide")] string qaAction) =>
        await engagement.AdminActionAsync(await User(), kind == "question", postId, qaAction == "publish");

    private async Task<Model.DomainModel.UserModel> User() => await current.RequireAsync();
}
