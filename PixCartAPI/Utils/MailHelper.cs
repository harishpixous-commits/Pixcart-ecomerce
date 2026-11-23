using MailKit;
using MailKit.Net.Smtp;
using MailKit.Security;
using MimeKit;
using Utils.Interface;
using Utils.UtilModels;

namespace Utils;

public class MailHelper : IMailHelper
{
    public async Task SendAsync(EmailModel email, IMailConfig config, CancellationToken ct = default)
    {
        if (!config.IsConfigured) throw new AppException("Email is not set up (Admin → Integrations → Email)", "email_not_configured");
        var message = new MimeMessage();
        message.From.Add(new MailboxAddress(email.FromName, config.From));
        message.To.Add(MailboxAddress.Parse(email.To));
        message.Subject = email.Subject;
        var body = new BodyBuilder { TextBody = email.Body, HtmlBody = email.HtmlBody };
        foreach (var (name, content, type) in email.Attachments) body.Attachments.Add(name, content, ContentType.Parse(type));
        message.Body = body.ToMessageBody();

        var security = config.Security switch
        {
            "ssl" => SecureSocketOptions.SslOnConnect,
            "none" => SecureSocketOptions.None,
            _ => SecureSocketOptions.StartTls,
        };
        try
        {
            using var smtp = new SmtpClient { Timeout = 20000 };
            await smtp.ConnectAsync(config.Host, config.Port, security, ct);
            if (!string.IsNullOrEmpty(config.User)) await smtp.AuthenticateAsync(config.User, config.Password, ct);
            await smtp.SendAsync(FormatOptions.Default, new SendRequest(message), ct);
            await smtp.DisconnectAsync(true, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            throw new AppException($"Could not send the email: {e.Message}", "email_failed", 502);
        }
    }
}
