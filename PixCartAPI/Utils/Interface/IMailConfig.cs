namespace Utils.Interface;

/// <summary>SMTP settings for sending email (Admin → Integrations → Email, or appsettings).</summary>
public interface IMailConfig
{
    string Host { get; }
    int Port { get; }
    string User { get; }
    string Password { get; }
    /// <summary>Sender address on a verified domain.</summary>
    string From { get; }
    /// <summary>"starttls", "ssl" or "none".</summary>
    string Security { get; }
    bool IsConfigured => !string.IsNullOrWhiteSpace(Host) && !string.IsNullOrWhiteSpace(From);
}

/// <summary>Plain settings object implementing <see cref="IMailConfig"/>.</summary>
public record MailConfig(string Host, int Port, string User, string Password, string From, string Security) : IMailConfig;
