using System.ComponentModel.DataAnnotations;
using System.Text.Json;

namespace Model.DomainModel.AI;

/// <summary>Runs an AI studio task (reference RunIn).</summary>
public record AiRunIn
{
    [StringLength(40)] public string SubjectId { get; init; } = "";
    [RegularExpression("^(friendly|formal|apologetic)$", ErrorMessage = "Input should be 'friendly', 'formal' or 'apologetic'")]
    public string Tone { get; init; } = "friendly";
    [StringLength(300)] public string Intent { get; init; } = "";
    [StringLength(4000)] public string Notes { get; init; } = "";
    public Guid? CategoryId { get; init; }
    [StringLength(80)] public string Brand { get; init; } = "";
}

public record AiFinishIn
{
    [StringLength(10000)] public string FinalText { get; init; } = "";
}

public record AiSendIn
{
    [Required, StringLength(150, MinimumLength = 3)] public string Subject { get; init; } = "";
    [Required, StringLength(2000, MinimumLength = 10)] public string Text { get; init; } = "";
}

/// <summary>An LLM connection (Admin → AI providers). Keys are added and removed by id; the browser never sees them.</summary>
public record LlmConnectionIn
{
    [StringLength(60)] public string Name { get; init; } = "";
    [Required, StringLength(30)] public string Type { get; init; } = "";
    [StringLength(300)] public string BaseUrl { get; init; } = "";
    [MaxLength(40)] public List<string> Models { get; init; } = [];
    public bool Enabled { get; init; } = true;
    [Range(5, 300)] public int TimeoutS { get; init; } = 60;
    [MaxLength(10)] public List<Dictionary<string, string>> AddKeys { get; init; } = [];
    [MaxLength(10)] public List<string> RemoveKeys { get; init; } = [];
}

public record LlmTestIn
{
    [StringLength(120)] public string Model { get; init; } = "";
}

public record LlmRoutesIn
{
    [Required] public Dictionary<string, List<Dictionary<string, string>>> Routes { get; init; } = [];
}

public record AssistantConversationIn
{
    [StringLength(120)] public string Title { get; init; } = "New chat";
    public Dictionary<string, JsonElement> Context { get; init; } = [];
}

public record AssistantConversationPatch
{
    [StringLength(120, MinimumLength = 1)] public string? Title { get; init; }
    public bool? Archived { get; init; }
}

public record AssistantAskIn
{
    [Required, StringLength(8000, MinimumLength = 1)] public string Text { get; init; } = "";
    [MaxLength(5)] public List<string> UploadIds { get; init; } = [];
    public Dictionary<string, JsonElement>? Page { get; init; }
    public bool Voice { get; init; }
}

public record AssistantDecisionTestIn
{
    [Required, StringLength(2000, MinimumLength = 1)] public string Text { get; init; } = "";
}

public record AssistantMemoryIn
{
    [MaxLength(30)] public List<string> Notes { get; init; } = [];
}

public record ShopStartIn
{
    public Dictionary<string, JsonElement> Page { get; init; } = [];
}

public record ShopMessageIn
{
    [Required, StringLength(2000, MinimumLength = 1)] public string Text { get; init; } = "";
    public bool Voice { get; init; }
    public Dictionary<string, JsonElement>? Page { get; init; }
}

public record ShopTicketIn
{
    [Required] public string Category { get; init; } = "";
    [Required, StringLength(200, MinimumLength = 5)] public string Subject { get; init; } = "";
    [Required, StringLength(5000, MinimumLength = 10)] public string Message { get; init; } = "";
    public Guid? OrderId { get; init; }
    public bool Grievance { get; init; }
}

public record ShopFeedbackIn
{
    [Required, RegularExpression("^(1|-1)$", ErrorMessage = "Input should be 1 or -1")] public int? Value { get; init; }
}

public record ShopArticleIn
{
    [Required, StringLength(160, MinimumLength = 3)] public string Title { get; init; } = "";
    [Required, StringLength(5000, MinimumLength = 10)] public string Body { get; init; } = "";
    [MaxLength(40)] public List<string> Keywords { get; init; } = [];
    public string Topic { get; init; } = "other";
    [StringLength(300)] public string Link { get; init; } = "";
    public bool IsPublished { get; init; } = true;
    [Range(0, 10000)] public int Position { get; init; }
}

public record ShopTryIn
{
    [Required, StringLength(300, MinimumLength = 2)] public string Question { get; init; } = "";
}
