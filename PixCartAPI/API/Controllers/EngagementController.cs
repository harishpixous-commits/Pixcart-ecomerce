using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel.Catalog;

namespace API.Controllers;

/// <summary>
/// Product questions and answers, back-in-stock alerts, product comparison and "Frequently bought together".
/// Questions: any signed-in shopper asks; the seller, verified buyers and (unless switched off) other shoppers answer.
/// Posts with phone numbers, emails or links wait for staff; reports hide a post until staff check it.
/// </summary>
[ApiController]
public class EngagementController(IEngagementBAL engagement, ICurrentUser me) : ControllerBase
{
    // ------------------------------------------------------------------------- shoppers

    [HttpGet("/api/catalog/products/{slug}/questions")]
    public async Task<JsonObject> Questions(string slug, [FromQuery, Len(0, 80)] string q = "",
        [FromQuery, OneOf("helpful", "recent")] string sort = "helpful", [FromQuery, Between(1, 200)] int page = 1) =>
        await engagement.QuestionsAsync(slug, await me.GetAsync(), q, sort, page);

    [HttpPost("/api/catalog/products/{slug}/questions"), SignedIn]
    public async Task<IActionResult> Ask(string slug, [FromBody] QuestionIn body) =>
        StatusCode(201, await engagement.AskAsync(slug, await me.RequireAsync(), body));

    [HttpPost("/api/questions/{questionId}/answers"), SignedIn]
    public async Task<IActionResult> Answer(Guid questionId, [FromBody] AnswerIn body) =>
        StatusCode(201, await engagement.AnswerAsync(questionId, await me.RequireAsync(), body));

    [HttpPost("/api/answers/{answerId}/helpful"), SignedIn]
    public async Task<JsonObject> AnswerHelpful(Guid answerId) => await engagement.AnswerHelpfulAsync(answerId, await me.RequireAsync());

    [HttpPost("/api/qa/report"), SignedIn]
    public async Task<JsonObject> Report([FromBody] QaReportIn body) => await engagement.ReportPostAsync(await me.RequireAsync(), body);

    // ------------------------------------------------------------------------- alerts

    [HttpPost("/api/alerts/stock"), SignedIn]
    public async Task<IActionResult> StockAlert([FromBody] AlertIn body) =>
        StatusCode(201, await engagement.SubscribeStockAlertAsync(await me.RequireAsync(), body.VariantId!.Value));

    [HttpDelete("/api/alerts/stock/{variantId}"), SignedIn]
    public async Task<JsonObject> StockAlertOff(Guid variantId) => await engagement.UnsubscribeStockAlertAsync(await me.RequireAsync(), variantId);

    [HttpGet("/api/alerts"), SignedIn]
    public async Task<JsonObject> MyAlerts([FromQuery(Name = "variant_id")] Guid? variantId = null) =>
        await engagement.MyAlertsAsync(await me.RequireAsync(), variantId);

    // ------------------------------------------------------------------------- compare and bought together

    [HttpGet("/api/catalog/compare")]
    public Task<JsonObject> Compare([FromQuery, Required(ErrorMessage = "is required"), Len(0, 200)] string ids) => engagement.CompareAsync(ids);

    [HttpGet("/api/catalog/products/{slug}/bought-together")]
    public Task<JsonObject> BoughtTogether(string slug) => engagement.BoughtTogetherAsync(slug);

    [HttpGet("/api/catalog/products/{slug}/bundles")]
    public Task<JsonObject> Bundles(string slug) => engagement.BundlesAsync(slug);

    // ------------------------------------------------------------------------- seller

    [HttpGet("/api/seller/questions"), Seller]
    public async Task<JsonObject> SellerQuestions([FromQuery] bool unanswered = false, [FromQuery, Between(1, int.MaxValue)] int page = 1) =>
        await engagement.SellerQuestionsAsync(await me.RequireSellerAsync(), unanswered, page);

    /// <summary>Small counts for the seller hub menu: orders to confirm, questions waiting, open customer reports, running deals.</summary>
    [HttpGet("/api/seller/badges"), Seller]
    public async Task<JsonObject> SellerBadges() => await engagement.SellerBadgesAsync(await me.RequireSellerAsync());

    [HttpPost("/api/seller/questions/{questionId}/answer"), Seller]
    public async Task<IActionResult> SellerAnswer(Guid questionId, [FromBody] AnswerIn body) =>
        StatusCode(201, await engagement.SellerAnswerAsync(questionId, await me.RequireSellerAsync(), await me.RequireAsync(), body));

    // ------------------------------------------------------------------------- staff

    /// <summary>Questions and answers in one queue: each row is a post (question or answer) with its context.</summary>
    [HttpGet("/api/admin/questions"), Perm("catalog")]
    public Task<JsonObject> AdminQuestions([FromQuery, OneOf("pending", "published", "hidden")] string status = "pending",
        [FromQuery, Len(0, 80)] string q = "", [FromQuery, Between(1, int.MaxValue)] int page = 1) =>
        engagement.AdminQuestionsAsync(status, q, page);

    [HttpPost("/api/admin/questions/{kind}/{postId}/{postAction}"), Perm("catalog")]
    public async Task<JsonObject> AdminQuestionAction([OneOf("question", "answer")] string kind, Guid postId, [OneOf("publish", "hide")] string postAction) =>
        await engagement.AdminQuestionActionAsync(await me.RequireAsync(), kind, postId, postAction);
}
