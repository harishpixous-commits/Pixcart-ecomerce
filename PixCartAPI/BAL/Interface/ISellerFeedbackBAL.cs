using System.Text.Json.Nodes;
using Model.DomainModel;
using Model.DomainModel.Catalog;
namespace BAL.Interface;
public interface ISellerFeedbackBAL
{
    Task<JsonObject> ReviewsAsync(SellerModel seller,int page,int? rating,bool unanswered,bool media,string q);
    Task<JsonObject> ReportReviewAsync(SellerModel seller,Guid review,ReviewReportIn body);
    Task<JsonObject> ReplyAsync(UserModel user,SellerModel seller,Guid review,string reply,string? run);
    Task<JsonObject> ProductReportsAsync(SellerModel seller,string? status,int page);
    Task<JsonObject> RespondAsync(UserModel user,SellerModel seller,Guid report,string note);
}
