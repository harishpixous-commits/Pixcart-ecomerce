using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IShippingBAL
{
    Task<JsonObject> BookAsync(UserModel user,SellerModel seller,Guid subId);
}
