using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// The seller's AI helpers: the listing writer and review replies (reference: routers/ai.py seller routes —
/// same paths, bodies and payloads). Runs are scoped to the seller's own account.
/// </summary>
[ApiController]
[Route("/api/seller/ai")]
[SignedIn]
public class SellerAiController(IAiBAL ai, ICurrentUser current) : ControllerBase
{
    /// <summary>Run a seller-audience task (reference: POST /api/seller/ai/tasks/{task}).</summary>
    [HttpPost("tasks/{task}")]
    public async Task<JsonObject> RunTask(string task, AiRunIn body)
    {
        var user = await current.RequireAsync();
        var seller = await current.RequireSellerAsync();
        if (!BAL.AiTasks.Tasks.TryGetValue(task, out var spec) || spec.Audience != "seller")
            throw new NotFoundException("AI task");
        var inputs = await ai.InputsAsync(task, body.Notes, body.CategoryId, body.Brand, body.Tone, body.Intent);
        var (r, _) = await ai.RunAsync(task, user, inputs, body.SubjectId, seller.Id);
        return ai.RunOut(r);
    }

    /// <summary>Apply or discard one of the seller's drafts (reference: POST /api/seller/ai/runs/{run_id}/{action}).</summary>
    [HttpPost("runs/{runId:guid}/{act}")]
    public async Task<JsonObject> Finish(Guid runId, string act, AiFinishIn body)
    {
        API.Helpers.PathChoice.Require(act, "action", "apply", "discard");
        var user = await current.RequireAsync();
        var seller = await current.RequireSellerAsync();
        var r = await ai.FinishAsync(runId.ToString(), act == "apply" ? "applied" : "discarded", user, body.FinalText, seller.Id)
            ?? throw new NotFoundException("AI draft");
        return ai.RunOut(r);
    }

    /// <summary>
    /// The product editor's one-shot listing writer (reference: POST /api/seller/ai/listing): the draft fields
    /// plus the run id so the editor can mark it applied.
    /// </summary>
    [HttpPost("listing")]
    public async Task<JsonObject> Listing(AiRunIn body)
    {
        var user = await current.RequireAsync();
        var seller = await current.RequireSellerAsync();
        var inputs = await ai.InputsAsync("listing_writer", body.Notes, body.CategoryId, body.Brand, body.Tone, body.Intent);
        var (r, output) = await ai.RunAsync("listing_writer", user, inputs, sellerId: seller.Id);
        output["run_id"] = r.Id.ToString();
        output["mode"] = r.Mode;
        return output;
    }
}
