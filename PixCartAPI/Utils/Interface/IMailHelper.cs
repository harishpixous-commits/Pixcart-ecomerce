using Utils.UtilModels;

namespace Utils.Interface;

public interface IMailHelper
{
    /// <summary>Sends one email with the given SMTP settings. Throws <see cref="AppException"/> (code "email_failed") on failure.</summary>
    Task SendAsync(EmailModel email, IMailConfig config, CancellationToken ct = default);
}
