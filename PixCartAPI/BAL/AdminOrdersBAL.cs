using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
namespace BAL;
public class AdminOrdersBAL(AdminOrdersDAL data,OrdersDAL orders,IOrdersBAL orderView,IAccessBAL access,Utils.Interface.IMySqlDapperHelper db,IAuditBAL audit,IRefundQueue refunds):IAdminOrdersBAL
{
    public async Task<JsonObject> ListAsync(UserModel user,AdminOrderQuery q)
    {await access.RequireAsync(user,"orders");var term=q.Q.Trim();var digits=new string(term.Where(char.IsDigit).ToArray());digits=digits.Length>=6?digits[^Math.Min(digits.Length,10)..]:"";var filter=new AdminOrderFilter(q.Status,term,"%"+term+"%",digits,q.PaymentMethod,q.PaymentStatus,q.PackageStatus,q.Seller,q.Customer,q.From,q.Until,(q.Page-1)*q.Size,q.Size,q.Late,q.Tag.Trim());var total=await data.CountAsync(filter);var rows=(await data.ListAsync(filter)).ToList();var packages=rows.Count>0?(await data.PackagesAsync(rows.Select(x=>x.Id).ToArray())).ToList():[];return new(){["items"]=new JsonArray(rows.Select(o=>(JsonNode)new JsonObject{["id"]=o.Id.ToString(),["number"]=o.Number,["customer"]=o.Customer,["phone"]=o.Phone,["status"]=o.Status,["payment_method"]=o.PaymentMethod,["payment_status"]=o.PaymentStatus,["grand_total"]=o.GrandTotal,["created_at"]=o.CreatedAt.ToString("o"),["staff_tags"]=OrderNotes.TagsOf(o.StaffTags),["package_statuses"]=new JsonArray(packages.Where(p=>p.OrderId==o.Id).Select(p=>(JsonNode)JsonValue.Create(p.Status)).ToArray())}).ToArray()),["total"]=total,["page"]=q.Page,["page_size"]=q.Size};}
    public async Task<JsonObject> DetailAsync(UserModel user,Guid id)
    {await access.RequireAsync(user,"orders");var order=await orders.GetOrderAsync(id)??throw new NotFoundException("Order");var result=await orderView.DetailAsync(order,true);var customer=await data.UserAsync(order.UserId)??throw new NotFoundException("User");result["staff_tags"]=OrderNotes.TagsOf(order.StaffTags);result["customer"]=new JsonObject{["id"]=customer.Id.ToString(),["name"]=customer.Name,["phone"]=customer.Phone,["email"]=customer.Email};result["refunds"]=new JsonArray((await orders.RefundsAsync(id)).Select(r=>(JsonNode)new JsonObject{["id"]=r.Id.ToString(),["amount"]=r.AmountPaise,["status"]=r.Status,["reason"]=r.Reason,["attempts"]=r.Attempts,["last_error"]=r.LastError,["provider_refund_id"]=r.ProviderRefundId}).ToArray());return result;}
    public async Task<JsonObject> CheckPaymentAsync(UserModel user,Guid id)
    {
        await access.RequireAsync(user,"orders");await using var tx=await db.BeginAsync();var payment=await orders.LatestPaymentForUpdateAsync(id,tx)??throw new AppException("This order was not paid online","no_online_payment");JsonObject result;try{result=await orderView.CheckWithGatewayAsync(payment,tx);}catch(RazorpayBAL.GatewayException e){throw new AppException("Could not reach Razorpay: "+e.Message,"gateway_error",502);}var word=result["result"]!.GetValue<string>();if(word=="already_paid")return result;var detail=result["payment"] is JsonObject p?word+" "+p["id"]!.GetValue<string>():$"not paid ({result["attempts"]!.AsArray().Count} attempts)";await audit.AuditAsync(user,"payment.check","order",id,detail,tx);await tx.CommitAsync();if(word=="refund")refunds.Enqueue(await orders.PendingRefundIdsAsync(payment.Id));return result;
    }
}
