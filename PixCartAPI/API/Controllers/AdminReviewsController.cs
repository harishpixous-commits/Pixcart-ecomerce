using System.Text.Json.Nodes;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Admin review moderation (reference: routers/admin_extras.py moderate_review).</summary>
[ApiController]
[Route("api/admin/reviews")]
public class AdminReviewsController(IReviewModerationBAL bal, ICurrentUser current) : ControllerBase
{
    private static readonly HashSet<string> Actions = ["publish", "hide", "publish-media", "hide-media", "dismiss-reports"];

    /// <summary>Moderate a review (reference: POST /api/admin/reviews/{review_id}/{action}).</summary>
    [HttpPost("{review_id:guid}/{review_action}")]
    public async Task<JsonObject> Moderate(Guid review_id, string review_action)
    {
        if (!Actions.Contains(review_action))
            throw new Utils.AppException("Unknown review action", "invalid_action", 422);
        return await bal.ModerateAsync(await current.RequireAsync(), review_id, review_action);
    }
}
