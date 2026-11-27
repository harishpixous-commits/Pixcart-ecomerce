namespace Tests;
public class TicketSatisfactionTests(ApiFactory f):ApiTest(f)
{
    [Fact]
    public async Task Customers_rate_a_resolved_request_once_and_staff_see_it()
    {
        var admin=await Admin();var buyer=await LoginPhone("9876200041");var other=await LoginPhone("9876200042");
        var tid=(await buyer.Post("/api/support/tickets",new{category="delivery",subject="Late parcel",message="Where is it?"})).Json["id"]!.GetValue<string>();
        var r=await buyer.Post($"/api/support/tickets/{tid}/rating",new{rating=5});Assert.Equal(409,r.Status);Assert.Equal("ticket_not_resolved",r.ErrorCode);
        Assert.Equal(200,(await admin.Post($"/api/admin/tickets/{tid}/reply",new{body="Sorted, it arrives tomorrow.",status="resolved"})).Status);
        Assert.Equal(422,(await buyer.Post($"/api/support/tickets/{tid}/rating",new{rating=6})).Status);
        Assert.Equal(404,(await other.Post($"/api/support/tickets/{tid}/rating",new{rating=4})).Status);
        r=await buyer.Post($"/api/support/tickets/{tid}/rating",new{rating=4,comment="  Quick   help "});Assert.Equal(200,r.Status);Assert.Equal(4,r.Json["csat_rating"]!.GetValue<int>());Assert.Equal("Quick help",r.Json["csat_comment"]!.GetValue<string>());
        r=await buyer.Post($"/api/support/tickets/{tid}/rating",new{rating=1});Assert.Equal(409,r.Status);Assert.Equal("already_rated",r.ErrorCode);
        var s=(await admin.Get("/api/admin/tickets/satisfaction")).Json;Assert.Equal(1,s["rated"]!.GetValue<long>());Assert.Equal(4.0,s["average"]!.GetValue<double>());Assert.Equal(1,s["spread"]!["4"]!.GetValue<long>());Assert.Equal(0,s["unrated_closed"]!.GetValue<long>());Assert.Equal("Quick help",s["recent"]![0]!["comment"]!.GetValue<string>());
        Assert.Equal(4,(await admin.Get($"/api/admin/tickets/{tid}")).Json["csat_rating"]!.GetValue<int>());
        Assert.Equal(403,(await buyer.Get("/api/admin/tickets/satisfaction")).Status);
    }
    [Fact]
    public async Task Support_staff_are_told_about_new_requests_replies_and_low_ratings()
    {
        var admin=await Admin();var buyer=await LoginPhone("9876200051");
        async Task<List<string>> Inbox()=>(await admin.Get("/api/notifications")).Json["items"]!.AsArray().Select(n=>n!["title"]!.GetValue<string>()).ToList();
        var tid=(await buyer.Post("/api/support/tickets",new{category="order",subject="Wrong colour",message="I got blue, not red.",is_grievance=true})).Json["id"]!.GetValue<string>();
        Assert.Contains(await Inbox(),t=>t.StartsWith("New grievance TK"));
        await buyer.Post($"/api/support/tickets/{tid}/messages",new{body="Any update?"});Assert.Contains(await Inbox(),t=>t.StartsWith("Customer replied on TK"));
        await admin.Post($"/api/admin/tickets/{tid}/reply",new{body="Sorry, a replacement is on the way.",status="resolved"});
        await buyer.Post($"/api/support/tickets/{tid}/rating",new{rating=2,comment="Slow"});Assert.Contains(await Inbox(),t=>t.StartsWith("Low rating on TK"));
        var tid2=(await buyer.Post("/api/support/tickets",new{category="order",subject="Thanks for the help",message="All fine now, thank you"})).Json["id"]!.GetValue<string>();
        await admin.Post($"/api/admin/tickets/{tid2}/reply",new{body="Great.",status="resolved"});await buyer.Post($"/api/support/tickets/{tid2}/rating",new{rating=5});
        Assert.Single((await Inbox()).Where(t=>t.StartsWith("Low rating")));
    }
}
