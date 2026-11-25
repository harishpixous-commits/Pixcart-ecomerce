using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Admin review moderation (reference: routers/admin_extras.py moderate_review).</summary>
public interface IReviewModerationBAL
{
    /// <summary>publish / hide / publish-media / hide-media / dismiss-reports (reference: POST /api/admin/reviews/{review_id}/{action}).</summary>
    Task<JsonObject> ModerateAsync(UserModel admin, Guid reviewId, string action);
}
