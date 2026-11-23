namespace Utils.UtilModels;

/// <summary>One SMS: either a one-time code (DLT OTP template) or a text message from a template.</summary>
public class SMSModel
{
    /// <summary>10-digit Indian mobile number (no +91).</summary>
    public string Phone { get; set; } = "";
    /// <summary>The one-time code, when this is an OTP SMS.</summary>
    public string? OtpCode { get; set; }
    /// <summary>The message text (non-OTP SMS).</summary>
    public string Message { get; set; } = "";
    /// <summary>MSG91 flow/template id for non-OTP messages.</summary>
    public string? TemplateId { get; set; }
    public Dictionary<string, string> Variables { get; set; } = [];
}

/// <summary>SMS provider settings, read from Admin → Integrations (or appsettings).</summary>
public class SmsConfig
{
    /// <summary>"console" (development: the code is written to the log) or "msg91".</summary>
    public string Provider { get; set; } = "console";
    public string AuthKey { get; set; } = "";
    public string OtpTemplateId { get; set; } = "";
    public string SenderId { get; set; } = "";
    public string ApiBase { get; set; } = "https://control.msg91.com";
}
