using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Utils;
using Utils.UtilModels;
using Xunit;

namespace PixCartAPI.Tests;

/// <summary>A failed MSG91 answer must never count as a sent OTP, including a 200 that is not JSON (a proxy page).</summary>
public class SmsAnswerTests
{
    private sealed class Handler(HttpStatusCode code, string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(code) { Content = new StringContent(body) });
    }

    private sealed class Factory(HttpStatusCode code, string body) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new Handler(code, body));
    }

    private static Task Send(HttpStatusCode code, string body) =>
        new SMSHelper(new Factory(code, body), NullLogger<SMSHelper>.Instance).SendOtpAsync(
            new SMSModel { Phone = "9876543210", OtpCode = "123456" },
            new SmsConfig { Provider = "msg91", AuthKey = "k", OtpTemplateId = "t", ApiBase = "https://control.msg91.com" });

    [Theory]
    [InlineData(HttpStatusCode.OK, "<html>maintenance</html>")]
    [InlineData(HttpStatusCode.OK, "{\"type\":\"error\",\"message\":\"bad\"}")]
    [InlineData(HttpStatusCode.InternalServerError, "oops")]
    public async Task Failed_answers_throw(HttpStatusCode code, string body) =>
        await Assert.ThrowsAsync<AppException>(() => Send(code, body));

    [Fact]
    public async Task A_success_answer_passes() => await Send(HttpStatusCode.OK, "{\"type\":\"success\"}");
}
