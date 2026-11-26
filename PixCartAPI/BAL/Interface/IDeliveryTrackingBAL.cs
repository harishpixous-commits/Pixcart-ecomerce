using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>
/// What a customer sees of the own delivery fleet on an order page: for every package a delivery partner carries,
/// the partner, the trip steps, the delivery code while the package is on its way and the partner's live position.
/// </summary>
public interface IDeliveryTrackingBAL
{
    /// <summary>Keyed by package id; packages that travel with a courier are not listed.</summary>
    Task<JsonObject> CustomerTrackingAsync(OrderModel order, IEnumerable<SubOrderModel> packages);
}
