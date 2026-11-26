using DAL;
using Microsoft.Extensions.DependencyInjection;
using Utils.Interface;

namespace Tests;

/// <summary>The seller dashboard's daily sales: counted on Indian days, like every other daily figure.</summary>
public class SellerDashboardTests(ApiFactory f) : ApiTest(f)
{
    [Fact]
    public async Task Daily_sales_are_counted_on_indian_days()
    {
        var shopper = await LoginPhone("9884000101", "Daily Shopper");
        var sellerUser = await LoginPhone("9884000102", "Daily Seller");
        var sellerId = Guid.Parse((await sellerUser.Post("/api/seller/register", new { display_name = "Daily Store" })).Json["id"]!.GetValue<string>());
        var at = DateTime.UtcNow.Date.AddDays(-2).AddHours(20); // 20:00 UTC is 01:30 the next day in India

        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var orders = scope.ServiceProvider.GetRequiredService<OrdersDAL>();
        var orderId = Guid.NewGuid();
        await using (var uow = await db.BeginAsync())
        {
            await orders.InsertOrderAsync(new()
            {
                Id = orderId, Number = "DAILY-1", UserId = Guid.Parse(shopper.Id), Status = "placed", PaymentMethod = "cod", PaymentStatus = "cod",
                ShipTo = "{}", Currency = "INR", FxRate = 1, Fees = "[]", IdempotencyKey = Guid.NewGuid().ToString(), CreatedAt = at, UpdatedAt = at,
            }, uow);
            await orders.InsertSubOrderAsync(new()
            {
                Id = Guid.NewGuid(), OrderId = orderId, SellerId = sellerId, Number = "DAILY-1-1", Status = "confirmed", SettlementStatus = "not_due",
                ItemsTotal = 49900, Total = 49900, CreatedAt = at, UpdatedAt = at,
            }, uow);
            await uow.CommitAsync();
        }

        var day = Assert.Single(await orders.DailySalesSinceAsync(sellerId, DateTime.UtcNow.AddDays(-30)));
        Assert.Equal(at.AddMinutes(330).ToString("yyyy-MM-dd"), day.Date);
        Assert.Equal(49900, day.Amount);
        Assert.Equal(1, day.Orders);
    }
}
