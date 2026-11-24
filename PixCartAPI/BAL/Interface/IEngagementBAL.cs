using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Product Q&A, stock alerts, comparison and bought-together (reference: routers/engagement.py).</summary>
public interface IEngagementBAL
{
    Task<JsonObject> QuestionsAsync(UserModel? user, string slug, string q, string sort, int page);
    Task<JsonObject> AskAsync(UserModel user, string slug, string text);
    Task<JsonObject> AnswerAsync(UserModel user, Guid questionId, string text);
    Task<JsonObject> AnswerHelpfulAsync(UserModel user, Guid answerId);
    Task<JsonObject> ReportAsync(UserModel user, bool question, Guid postId);
    Task<JsonObject> StockAlertOnAsync(UserModel user, Guid variantId);
    Task<JsonObject> StockAlertOffAsync(UserModel user, Guid variantId);
    Task<JsonObject> MyAlertsAsync(UserModel user, Guid? variantId);
    Task<JsonObject> CompareAsync(string ids);
    Task<JsonObject> BoughtTogetherAsync(string slug);
    Task<JsonObject> SellerQuestionsAsync(UserModel user, bool unanswered, int page);
    Task<JsonObject> SellerBadgesAsync(UserModel user);
    Task<JsonObject> SellerAnswerAsync(UserModel user, Guid questionId, string text);
    Task<JsonObject> AdminQueueAsync(UserModel admin, string status, string q, int page);
    Task<JsonObject> AdminActionAsync(UserModel admin, bool question, Guid postId, bool publish);
    /// <summary>Reference: send_stock_alerts (alerts job) — one notification per subscription when the version is back.</summary>
    Task<int> SendStockAlertsAsync();

    /// <summary>Reference: send_price_drops (alerts job) — one notification per new lower price on a wishlisted product.</summary>
    Task<int> SendPriceDropsAsync();
}

