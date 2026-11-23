using Utils.UtilModels;

namespace Utils.Interface;

public interface ISMSHelper
{
    /// <summary>Sends a one-time code. With the "console" provider the code is written to the log
    /// as "DEV OTP for &lt;phone&gt;: &lt;code&gt;" (development and automated tests only).</summary>
    Task SendOtpAsync(SMSModel sms, SmsConfig config, CancellationToken ct = default);

    /// <summary>Sends a text message from an approved (DLT) template.</summary>
    Task SendMessageAsync(SMSModel sms, SmsConfig config, CancellationToken ct = default);
}
