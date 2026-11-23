namespace Utils.UtilModels;

/// <summary>One email to send.</summary>
public class EmailModel
{
    public string To { get; set; } = "";
    public string Subject { get; set; } = "";
    /// <summary>Plain text body; the footer with the business details is added by the caller.</summary>
    public string Body { get; set; } = "";
    /// <summary>Optional HTML version of the body.</summary>
    public string? HtmlBody { get; set; }
    /// <summary>Display name of the sender (the brand name).</summary>
    public string FromName { get; set; } = "";
    public List<(string FileName, byte[] Content, string ContentType)> Attachments { get; set; } = [];
}
