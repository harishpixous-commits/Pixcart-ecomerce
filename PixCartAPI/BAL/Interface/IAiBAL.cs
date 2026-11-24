using System.Text.Json.Nodes;
using Model.DomainModel;
using Model.DomainModel.AI;

namespace BAL.Interface;

/// <summary>AI studio (drafts a person reviews), the AI run log and the deterministic risk briefs.</summary>
public interface IAiBAL
{
    Task<bool> ConfiguredAsync(string route = "studio");
    Task<string> ModeAsync();
    Task<bool> AvailableAsync(string task);
    Task<JsonObject> UsageThisMonthAsync();

    /// <summary>Runs one task and records it in ai_runs. Other modules (product moderation, support desk) call this too.</summary>
    Task<(AiRunModel Run, JsonObject Output)> RunAsync(string taskKey, UserModel? actor, JsonObject inputs, string subjectId = "", Guid? sellerId = null);

    JsonObject RunOut(AiRunModel r, JsonObject? cfg = null);

    /// <summary>Records what a person did with a draft (applied, sent, discarded); null when it is not an open draft.</summary>
    Task<AiRunModel?> FinishAsync(string runId, string status, UserModel actor, string finalText = "", Guid? sellerId = null);

    Task<JsonObject> StudioAsync();
    Task<JsonObject> SaveStudioAsync(JsonObject body, UserModel admin);
    Task<JsonObject> RunsAsync(string? task, string? status, int page);
    Task<JsonObject> RunDetailAsync(Guid id);
    Task<JsonObject> AdminRunAsync(string task, AiRunIn body, UserModel admin);
    Task<JsonObject> AdminSendAsync(Guid runId, AiSendIn body, UserModel admin);
    Task<JsonObject> AdminFinishAsync(Guid runId, string action, AiFinishIn body, UserModel admin);
    Task<JsonObject> SellerRunAsync(string task, AiRunIn body, SellerModel seller, UserModel user);
    Task<JsonObject> SellerFinishAsync(Guid runId, string action, AiFinishIn body, SellerModel seller, UserModel user);
    Task<JsonObject> SellerListingAsync(AiRunIn body, SellerModel seller, UserModel user);
    Task<JsonObject> SellerRiskAsync(SellerModel seller);
    Task<JsonObject> OrderRiskAsync(OrderModel order);
    Task<JsonObject> SellerBriefAsync(Guid sellerId);
    Task<JsonObject> OrderBriefAsync(Guid orderId);
    Task ReviewSummaryJobAsync();
    Task CleanupJobAsync();
}
