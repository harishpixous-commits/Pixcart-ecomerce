using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public record AdminOrderQuery(string? Status,string Q,string? PaymentMethod,string? PaymentStatus,string? PackageStatus,Guid? Seller,Guid? Customer,DateTime? From,DateTime? Until,int Page,int Size,bool Late=false);
public interface IAdminOrdersBAL
{
    Task<JsonObject> CheckPaymentAsync(UserModel user,Guid id);
    Task<JsonObject> ListAsync(UserModel user,AdminOrderQuery q);
    Task<JsonObject> DetailAsync(UserModel user,Guid id);
}
