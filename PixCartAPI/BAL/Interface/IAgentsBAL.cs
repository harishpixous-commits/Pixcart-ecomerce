using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;

/// <summary>AI agents (mirror of app/agents + routers/agents.py): agents write proposals from real data, staff approve or reject them in Admin → AI agents.
/// Nothing runs without an Approve. Rule-based, no paid AI service.</summary>
public interface IAgentsBAL
{
    Task<JsonObject> OverviewAsync(UserModel admin);
    Task<JsonObject> SaveSettingsAsync(UserModel admin, JsonObject body);
    Task<JsonObject> ProposalsAsync(UserModel admin, string status, string? agent);
    Task<JsonObject> RunNowAsync(UserModel admin);
    Task<JsonObject> DecideAsync(UserModel admin, Guid id, string decision);
    /// <summary>The scheduled job: every switched-on agent scans, old proposals expire. Returns how many proposals were written.</summary>
    Task<int> RunAllAsync();
}
