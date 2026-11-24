using System.Text.Json.Nodes;
using Model.DomainModel;
using Model.DomainModel.Catalog;

namespace BAL.Interface;

/// <summary>
/// Product questions and answers (shoppers ask; the seller, verified buyers and other shoppers answer; posts with
/// contact details wait for staff; reports from enough people hide a post), back-in-stock and wishlist price-drop
/// alerts, compare and "Frequently bought together".
/// </summary>
public interface IEngagementBAL
{
    Task<JsonObject> QuestionsAsync(string slug, UserModel? user, string q, string sort, int page);
    Task<JsonObject> AskAsync(string slug, UserModel user, QuestionIn body);
    Task<JsonObject> AnswerAsync(Guid questionId, UserModel user, AnswerIn body);
    Task<JsonObject> AnswerHelpfulAsync(Guid answerId, UserModel user);
    Task<JsonObject> ReportPostAsync(UserModel user, QaReportIn body);

    Task<JsonObject> SubscribeStockAlertAsync(UserModel user, Guid variantId);
    Task<JsonObject> UnsubscribeStockAlertAsync(UserModel user, Guid variantId);
    Task<JsonObject> MyAlertsAsync(UserModel user, Guid? variantId);

    Task<JsonObject> CompareAsync(string ids);
    Task<JsonObject> BoughtTogetherAsync(string slug);

    Task<JsonObject> SellerQuestionsAsync(SellerModel seller, bool unanswered, int page);
    Task<JsonObject> SellerBadgesAsync(SellerModel seller);
    Task<JsonObject> SellerAnswerAsync(Guid questionId, SellerModel seller, UserModel user, AnswerIn body);

    Task<JsonObject> AdminQuestionsAsync(string status, string q, int page);
    Task<JsonObject> AdminQuestionActionAsync(UserModel admin, string kind, Guid postId, string action);

    /// <summary>Job: tells shoppers a version is back in stock (once per request). Returns how many were told.</summary>
    Task<int> SendStockAlertsAsync();

    /// <summary>Job: tells shoppers a wishlist product is cheaper by the set percentage. Returns how many were told.</summary>
    Task<int> SendPriceDropsAsync();

    /// <summary>Remembers the price when a product is saved to the wishlist (call after adding it), for price-drop alerts.</summary>
    Task WishlistPriceOnAddAsync(Guid userId, Guid productId);
}
