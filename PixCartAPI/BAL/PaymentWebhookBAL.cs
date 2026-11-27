using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils;
namespace BAL;
public partial class WebhookBAL
{
    public async Task<object> RazorpayAsync(byte[] body,string signature,string? eventIdHeader)
    {
        var gateway=services.GetRequiredService<IRazorpayBAL>();if(!await gateway.VerifyWebhookSignatureAsync(body,signature))throw new AppException("Invalid signature","bad_signature",400);
        JsonObject evt;try{evt=JsonNode.Parse(body) as JsonObject??[];}catch(JsonException){throw new AppException("The request could not be read","bad_request",400);}
        var kind=S(evt["event"]);var eid=!string.IsNullOrEmpty(eventIdHeader)?eventIdHeader:Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(body));
        var orderDal=services.GetRequiredService<OrdersDAL>();var orderBal=services.GetRequiredService<IOrdersBAL>();var refundIds=new List<Guid>();RefundModel? notify=null;
        await using(var tx=await db.BeginAsync())
        {
            if(!await dal.RecordWebhookOnceAsync("razorpay",Cut(eid,80),Cut(kind,60),DateTimeFunctions.UtcNow(),tx.Transaction))return new{ok=true,duplicate=true};
            var paymentEntity=evt["payload"]?["payment"]?["entity"] as JsonObject??[];
            if(kind is "payment.captured" or "order.paid")
            {
                var payment=await orderDal.PaymentByProviderOrderForUpdateAsync(S(paymentEntity["order_id"]),tx);
                if(payment is not null&&S(paymentEntity["status"])=="captured")
                {
                    var result=await orderBal.MarkPaidAsync(payment,S(paymentEntity["id"]),S(paymentEntity["method"]),paymentEntity["amount"]?.GetValue<long>()??0,tx);
                    if(result=="refund")refundIds=(await tx.QueryAsync<Guid>("SELECT id FROM refunds WHERE order_id=@id AND status='pending' AND provider_refund_id IS NULL",new{id=payment.OrderId})).ToList();
                }
            }
            else if(kind=="payment.failed")
            {
                var payment=await orderDal.PaymentByProviderOrderForUpdateAsync(S(paymentEntity["order_id"]),tx);
                if(payment is not null&&payment.Status!="captured"){payment.Error=Cut(S(paymentEntity["error_description"]),500);await orderDal.UpdatePaymentAsync(payment,tx);}
            }
            else if(kind is "refund.processed" or "refund.failed")
            {
                var entity=evt["payload"]?["refund"]?["entity"] as JsonObject??[];
                var refund=await tx.QueryFirstOrDefaultAsync<RefundModel>("SELECT * FROM refunds WHERE provider_refund_id=@id FOR UPDATE",new{id=S(entity["id"])});
                if(refund is not null)
                {
                    var newly=kind=="refund.processed"&&refund.Status!="processed";refund.Status=kind=="refund.processed"?"processed":"failed";refund.LastError=kind=="refund.processed"?"":"Gateway reported the refund failed";await orderDal.UpdateRefundAsync(refund,tx);
                    if(newly)notify=refund;
                }
            }
            await tx.CommitAsync();
        }
        if(notify is not null)await orderBal.NotifyRefundProcessedAsync(notify);
        if(refundIds.Count>0)services.GetRequiredService<IRefundQueue>().Enqueue(refundIds);return new{ok=true};
    }
}
