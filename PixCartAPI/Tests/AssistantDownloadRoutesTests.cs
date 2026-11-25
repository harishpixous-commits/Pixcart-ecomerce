using System.Net.Http.Headers;
using Microsoft.AspNetCore.Routing;
using System.Text.Json;
using System.Text;
using System.Text.Json.Nodes;
using ClosedXML.Excel;
using DAL;
using Microsoft.Extensions.DependencyInjection;
namespace Tests;

public class AssistantDownloadRoutesTests(ApiFactory f) : ApiTest(f)
{
    private async Task<(Guid Conv, Guid Question, Guid Answer)> Seed(Api user, string title)
    {
        var response = await user.Post("/api/admin/assistant/conversations", new { title });
        Assert.Equal(201, response.Status); var conv = Guid.Parse(response.Json["id"]!.GetValue<string>());
        var question = Guid.NewGuid(); var answer = Guid.NewGuid();
        var older = Guid.NewGuid();
        await ApiFactory.DbExecAsync("""
            INSERT INTO assistant_messages (id,conversation_id,role,text,blocks,model_content,status,mode,upload_ids,input_tokens,output_tokens,created_at)
            VALUES (@older,@conv,'user','Obsolete earlier question','[]','null','done','sandbox','[]',0,0,'2026-11-24 11:59:00'),
            (@question,@conv,'user','Earlier question','[]','null','done','sandbox','[]',0,0,'2026-11-24 12:00:00'),
            (@answer,@conv,'assistant','Raw saved answer',@blocks,'null','done','sandbox','[]',0,0,'2026-11-24 12:01:00')
            """, new { conv, older, question, answer, blocks = """
            [{"type":"text","text":"Saved **answer** ₹999.50"},{"type":"table","title":"Saved table","columns":["Item","Amount"],"rows":[["=BAD",999.50]]},{"type":"action","action_id":"00000000-0000-0000-0000-000000000001","summary":"Original proposal","status":"pending"}]
            """ });
        await ApiFactory.DbExecAsync("""
            INSERT INTO assistant_messages (id,conversation_id,role,text,blocks,model_content,status,mode,upload_ids,input_tokens,output_tokens,created_at)
            VALUES (@id,@conv,'user','Future question','[]','null','done','sandbox','[]',0,0,'2026-11-24 12:02:00')
            """, new { id = Guid.NewGuid(), conv });
        return (conv, question, answer);
    }
    [Fact]
    public async Task Download_routes_serve_five_saved_formats_and_nearest_prior_question()
    {
        var admin = await Admin(); var ids = await Seed(admin, "Tamil தமிழ் / Saved <Report>");
        if (Environment.GetEnvironmentVariable("PIXCART_ROUTE_DIAGNOSTICS") == "1")
        {
            var endpoints = Factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
                .SelectMany(e => (e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? []).Select(m => new { method = m, path = e.RoutePattern.RawText })).ToArray();
            await File.WriteAllTextAsync("/tmp/pixcart-live-dotnet-routes.json", JsonSerializer.Serialize(endpoints));
        }
        using var scope = Factory.Services.CreateScope(); await scope.ServiceProvider.GetRequiredService<SettingsDAL>().SaveAsync("site", new JsonObject { ["brand_name"] = "Synthetic Brand" });
        using var client = Factory.CreateClient();
        async Task<(byte[] Bytes, string Name)> Download(string path, string media)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, path); req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin.Token);
            using var res = await client.SendAsync(req); Assert.Equal(200, (int)res.StatusCode);
            Assert.True(res.Headers.CacheControl?.NoStore); Assert.Equal(media, res.Content.Headers.ContentType?.MediaType);
            return (await res.Content.ReadAsByteArrayAsync(), res.Content.Headers.ContentDisposition?.FileName?.Trim('"') ?? "");
        }
        await ApiFactory.DbExecAsync("INSERT INTO assistant_actions (id,conversation_id,user_id,kind,params,summary,status,result,created_at) VALUES ('00000000-0000-0000-0000-000000000001',@conv,@user,'set_announcement','{}','Saved action','done','null',UTC_TIMESTAMP(6))", new { conv = ids.Conv, user = Guid.Parse(admin.Id) });
        var patched = await admin.Get($"/api/admin/assistant/conversations/{ids.Conv}");
        Assert.Equal("done", patched.Json["messages"]!.AsArray().Single(m => m!["id"]!.GetValue<string>() == ids.Answer.ToString())!["blocks"]![2]!["status"]!.GetValue<string>());
        var prefix = $"/api/admin/assistant/messages/{ids.Answer}/download.";
        var json = await Download(prefix + "json", "application/json");
        Assert.Equal("tamil-saved-report-20261124-1201.json", json.Name);
        var payload = JsonNode.Parse(json.Bytes)!; Assert.Equal("Synthetic Brand assistant \u2014 Tamil தமிழ் / Saved <Report>", payload["title"]!.GetValue<string>());
        Assert.Equal(2, payload["messages"]!.AsArray().Count); Assert.Equal(ids.Question.ToString(), payload["messages"]![0]!["id"]!.GetValue<string>());
        Assert.Equal("pending", payload["messages"]![1]!["blocks"]![2]!["status"]!.GetValue<string>());
        Assert.DoesNotContain("Future question", Encoding.UTF8.GetString(json.Bytes));
        var md = await Download(prefix + "md", "text/markdown"); Assert.Contains("Saved **answer** ₹999.50", Encoding.UTF8.GetString(md.Bytes));
        var csv = await Download(prefix + "csv", "text/csv"); Assert.Contains("'=BAD,999.5", Encoding.UTF8.GetString(csv.Bytes));
        var xlsx = await Download(prefix + "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); using var book = new XLWorkbook(new MemoryStream(xlsx.Bytes)); Assert.Equal("=BAD", book.Worksheet(1).Cell(2, 1).GetString());
        var pdf = await Download(prefix + "pdf", "application/pdf"); Assert.Equal("%PDF", Encoding.ASCII.GetString(pdf.Bytes, 0, 4));
        var full = await Download($"/api/admin/assistant/conversations/{ids.Conv}/download.json", "application/json"); Assert.Equal("tamil-saved-report.json", full.Name); Assert.Equal(4, JsonNode.Parse(full.Bytes)!["messages"]!.AsArray().Count);
        var question = await Download($"/api/admin/assistant/messages/{ids.Question}/download.json", "application/json"); Assert.Single(JsonNode.Parse(question.Bytes)!["messages"]!.AsArray());
    }
    [Fact]
    public async Task Download_routes_hide_other_owners_enforce_permission_and_check_format_first()
    {
        var admin = await Admin(); var ids = await Seed(admin, "தமிழ்"); var other = await Staff(admin, "download-other@example.test");
        var p = $"/api/admin/assistant/messages/{ids.Answer}/download.json";
        Assert.Equal(404, (await other.Get(p)).Status);
        Assert.Equal(404, (await other.Get($"/api/admin/assistant/conversations/{ids.Conv}/download.json")).Status);
        Assert.Contains("Format", (await other.Get($"/api/admin/assistant/messages/{Guid.NewGuid()}/download.exe")).ErrorMessage ?? "");
        var customer = await LoginPhone("9876123490"); Assert.Equal(403, (await customer.Get(p)).Status);
        Assert.Equal(401, (await Factory.Browser().Get(p)).Status);
        using var client = Factory.CreateClient(); using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/admin/assistant/conversations/{ids.Conv}/download.md"); req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin.Token); using var response = await client.SendAsync(req); Assert.Equal("assistant.md", response.Content.Headers.ContentDisposition?.FileName?.Trim('"'));
    }
}
