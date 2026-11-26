using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Utils.Interface;

namespace Tests;

/// <summary>
/// A package our own delivery partners carry: what the customer sees of the trip on the order page, and what
/// cancelling the package does to the partner's trip.
/// </summary>
public class DeliveryTrackingTests(ApiFactory factory) : ApiTest(factory)
{
    private sealed record FleetPackage(Guid OrderId, Guid PackageId, Guid TripId, Guid PartnerId);

    [Fact]
    public async Task Order_page_shows_the_partner_and_the_code_only_while_the_package_is_with_the_partner()
    {
        var shopper = await LoginPhone("9882000001", "Tracking Shopper");
        var package = await SeedFleetPackageAsync(shopper, "9882000009", packageStatus: "packed", tripStatus: "accepted");

        var view = await TrackingAsync(shopper, package);
        Assert.Equal("accepted", view["assignment"]!["status"]!.GetValue<string>());
        Assert.Null(view["assignment"]!["fee"]);                                      // the partner's pay stays private
        Assert.Equal("Tracking Partner", view["partner"]!["name"]!.GetValue<string>());
        Assert.Equal("9882000009", view["partner"]!["phone"]!.GetValue<string>());   // on the trip: the number is shown
        Assert.Null(view["otp"]);                                                     // not picked up yet: no code

        await SetTripStatusAsync(package.TripId, "on_the_way");
        view = await TrackingAsync(shopper, package);
        Assert.Equal("4321", view["otp"]!.GetValue<string>());
        Assert.False(view["can_rate"]!.GetValue<bool>());

        await SetTripStatusAsync(package.TripId, "delivered");
        view = await TrackingAsync(shopper, package);
        Assert.Equal("", view["partner"]!["phone"]!.GetValue<string>());             // after the trip the number is hidden
        Assert.Null(view["otp"]);
        Assert.True(view["can_rate"]!.GetValue<bool>());

        var stranger = await LoginPhone("9882000002");
        Assert.Equal(404, (await stranger.Get($"/api/orders/{package.OrderId}")).Status);
    }

    [Fact]
    public async Task Cancelling_before_pickup_stops_the_trip()
    {
        var shopper = await LoginPhone("9882000011", "Cancel Shopper");
        var package = await SeedFleetPackageAsync(shopper, "9882000019", packageStatus: "packed", tripStatus: "accepted");

        var cancel = await shopper.Post($"/api/orders/{package.OrderId}/cancel", new { reason = "Ordered by mistake", sub_order_id = package.PackageId });
        Assert.True(cancel.Status == 200, cancel.ToString());

        Assert.Equal("cancelled", await ApiFactory.DbScalarAsync<string>("SELECT status FROM delivery_assignments WHERE id=@id", new { id = package.TripId }));
        Assert.Contains("Do not pick it up", await ApiFactory.DbScalarAsync<string>("SELECT reject_reason FROM delivery_assignments WHERE id=@id", new { id = package.TripId }));
        Assert.Equal(0, await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM delivery_assignments WHERE sub_order_id=@id AND kind='return'", new { id = package.PackageId }));
    }

    [Fact]
    public async Task Cancelling_after_pickup_sends_the_package_back_to_the_store()
    {
        var shopper = await LoginPhone("9882000021", "Return Shopper");
        var package = await SeedFleetPackageAsync(shopper, "9882000029", packageStatus: "shipped", tripStatus: "on_the_way");

        using (var scope = Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
            var orders = scope.ServiceProvider.GetRequiredService<OrdersDAL>();
            var ordersBal = scope.ServiceProvider.GetRequiredService<IOrdersBAL>();
            await using var uow = await db.BeginAsync();
            var sub = await orders.GetSubAsync(package.PackageId) ?? throw new InvalidOperationException("package missing");
            await ordersBal.CancelSubOrderAsync(sub, "admin", "Returned to origin", uow);
            await uow.CommitAsync();
        }

        Assert.Equal("cancelled", await ApiFactory.DbScalarAsync<string>("SELECT status FROM delivery_assignments WHERE id=@id", new { id = package.TripId }));
        Assert.Contains("Bring the package back to the store", await ApiFactory.DbScalarAsync<string>("SELECT reject_reason FROM delivery_assignments WHERE id=@id", new { id = package.TripId }));
        Assert.Equal("picked", await ApiFactory.DbScalarAsync<string>(
            "SELECT status FROM delivery_assignments WHERE sub_order_id=@id AND kind='return' AND delivery_boy_id=@partner AND picked_at IS NOT NULL",
            new { id = package.PackageId, partner = package.PartnerId }));
    }

    // ------------------------------------------------------------------------------------------------------- helpers

    /// <summary>An order with one package carried by our delivery fleet, a partner and that partner's trip.</summary>
    private async Task<FleetPackage> SeedFleetPackageAsync(Api shopper, string partnerPhone, string packageStatus, string tripStatus)
    {
        var sellerUser = await LoginPhone(partnerPhone[..^1] + "8", "Tracking Seller");
        var sellerId = Guid.Parse((await sellerUser.Post("/api/seller/register", new { display_name = $"Tracking Store {partnerPhone[^3..]}" })).Json["id"]!.GetValue<string>());
        var partnerUser = await LoginPhone(partnerPhone, "Tracking Partner");
        var package = new FleetPackage(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var now = DateTime.UtcNow;

        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var orders = scope.ServiceProvider.GetRequiredService<OrdersDAL>();
        var partners = scope.ServiceProvider.GetRequiredService<DeliveryDAL>();
        await partners.InsertPartnerAsync(new()
        {
            Id = package.PartnerId, UserId = Guid.Parse(partnerUser.Id), Name = "Tracking Partner", Phone = partnerPhone, VehicleType = "bike",
            VehicleNo = "TN01AB1234", KycStatus = "approved", BankDetails = "{}", IsActive = true, CreatedAt = now, UpdatedAt = now,
        });
        await using (var uow = await db.BeginAsync())
        {
            await orders.InsertOrderAsync(new()
            {
                Id = package.OrderId, Number = "TRACK-" + partnerPhone[^4..], UserId = Guid.Parse(shopper.Id), Status = "placed", PaymentMethod = "cod",
                PaymentStatus = "cod", ShipTo = """{"city": "Chennai", "lat": 13.0418, "lng": 80.2341}""", Currency = "INR", FxRate = 1, Fees = "[]",
                IdempotencyKey = Guid.NewGuid().ToString(), CreatedAt = now, UpdatedAt = now,
            }, uow);
            await orders.InsertSubOrderAsync(new()
            {
                Id = package.PackageId, OrderId = package.OrderId, SellerId = sellerId, Number = "TRACK-" + partnerPhone[^4..] + "-1",
                Status = packageStatus, SettlementStatus = "not_due", CreatedAt = now, UpdatedAt = now,
            }, uow);
            await uow.ExecuteAsync("UPDATE sub_orders SET shipping_provider='fleet', delivery_otp='4321', ready_for_pickup_at=@now WHERE id=@id",
                new { now, id = package.PackageId });
            await uow.ExecuteAsync(
                "INSERT INTO delivery_assignments (id, order_id, sub_order_id, delivery_boy_id, mode, kind, status, reject_reason, assigned_at, accepted_at, " +
                "status_at, cod_amount, cod_collected, cod_method, proof_photo, fee_paise, fail_reason, rating_comment, created_at) " +
                "VALUES (@trip, @order, @package, @partner, 'auto', 'delivery', @status, '', @now, @now, @now, 0, 0, '', '', 3000, '', '', @now)",
                new { trip = package.TripId, order = package.OrderId, package = package.PackageId, partner = package.PartnerId, status = tripStatus, now });
            await uow.CommitAsync();
        }
        return package;
    }

    private static async Task<JsonNode> TrackingAsync(Api shopper, FleetPackage package)
    {
        var order = await shopper.Get($"/api/orders/{package.OrderId}");
        Assert.True(order.Status == 200, order.ToString());
        return order.Json["fleet"]![package.PackageId.ToString()] ?? throw new InvalidOperationException("no tracking for the package");
    }

    private static Task SetTripStatusAsync(Guid tripId, string status) =>
        ApiFactory.DbExecAsync("UPDATE delivery_assignments SET status=@status WHERE id=@tripId", new { status, tripId });
}
