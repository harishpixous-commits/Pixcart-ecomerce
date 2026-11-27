using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils.Interface;
namespace BAL.Interface;

/// <summary>Starting, checking and refunding payments across gateways (docs/PAYMENT_GATEWAYS.md sections 3 to 5) and the
/// Admin → Payments data. Mirror of services/payment_gateways.py. Razorpay keeps its own BAL; the others use PaymentGateways.cs.</summary>
public interface IPaymentGatewayBAL
{
    /// <summary>Creates the gateway payment (first eligible gateway, then the next when failover is on) and inserts the Payment row.
    /// 409 when no gateway can take it, 502 when every one failed.</summary>
    Task<PaymentModel> StartAsync(OrderModel order, UserModel user, long amount, long? charge, string chargeCurrency, IUnitOfWork uow, string? preferred = null, string? after = null);
    Task<JsonArray> AlternativesAsync(string currency, string current);
    /// <summary>The `payment` object of section 4 for a gateway other than Razorpay.</summary>
    Task<JsonObject> PayloadAsync(OrderModel order, PaymentModel payment, UserModel user, string brand);
    /// <summary>check_with_gateway for the non-Razorpay gateways.</summary>
    Task<JsonObject> CheckAsync(PaymentModel payment, IUnitOfWork uow, Func<PaymentModel, string, string, long, IUnitOfWork, Task<string>> markPaid);
    Task<GatewayRefund> RefundAsync(PaymentModel payment, string providerPaymentId, long chargePaise, string refundId, string note);
    /// <summary>The adapter that reads a gateway's return or webhook (never Razorpay).</summary>
    Task<PaymentGateway> AdapterAsync(string code);
    Task<JsonObject> GatewaysAsync(UserModel admin);
    Task<JsonObject> UpdateRoutingAsync(UserModel admin, JsonObject body);
    Task<JsonObject> TestAsync(UserModel admin, string code);
}

/// <summary>Switch, return and webhook flows of the extra gateways (they need the order service, so they live apart).</summary>
public interface IPaymentFlowBAL
{
    Task<JsonObject> SwitchAsync(UserModel user, Guid orderId, string? provider);
    Task<(Guid? OrderId, string Outcome, string Reason)> ReturnAsync(string code, IReadOnlyDictionary<string, string> data);
    Task<object> WebhookAsync(string code, IReadOnlyDictionary<string, string> headers, byte[] body);
}
