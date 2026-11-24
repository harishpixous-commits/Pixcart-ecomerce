using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface ISellerProductsBAL
{
    Task<JsonObject> ListAsync(SellerModel seller,string? status,string q,bool lowStock,int page,int pageSize);
    Task<JsonObject> DetailAsync(SellerModel seller,Guid id);
    Task<JsonObject> RequirementsAsync(SellerModel seller,Guid categoryId);
    Task<object> CategoriesAsync(SellerModel seller);
    Task<JsonObject> FeesAsync();
    Task<JsonObject> LifecycleAsync(UserModel user,SellerModel seller,Guid id,string action);
    Task<JsonObject> PatchAsync(SellerModel seller,Guid variantId,long? price,long? mrp,int? stock,bool? active);
}
