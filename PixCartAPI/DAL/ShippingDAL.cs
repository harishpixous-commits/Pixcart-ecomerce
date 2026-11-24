using Model.DomainModel;
using Utils.Interface;
namespace DAL;

/// <summary>Transaction-scoped courier token, pickup and shipment storage.</summary>
public sealed class ShippingDAL
{
    public Task<IntegrationTokenModel?> TokenAsync(IUnitOfWork tx)=>tx.QueryFirstOrDefaultAsync<IntegrationTokenModel>("SELECT * FROM integration_tokens WHERE provider='shiprocket'");
    public Task<int> SaveTokenAsync(string token,DateTime expires,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO integration_tokens(provider,token,expires_at)VALUES('shiprocket',@token,@expires) ON DUPLICATE KEY UPDATE token=VALUES(token),expires_at=VALUES(expires_at)",new{token,expires});
    public Task<WarehouseModel?> WarehouseAsync(Guid? id,IUnitOfWork tx)=>tx.QueryFirstOrDefaultAsync<WarehouseModel>("SELECT * FROM warehouses WHERE id=@id",new{id});
    public Task<IEnumerable<VariantModel>> VariantsAsync(Guid[] ids,IUnitOfWork tx)=>tx.QueryAsync<VariantModel>("SELECT * FROM variants WHERE id IN @ids",new{ids});
    public Task<int> SavePickupAsync(Guid id,string pickup,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE warehouses SET shiprocket_pickup_name=@pickup WHERE id=@id",new{pickup,id});
    public Task<int> SaveShipmentAsync(SubOrderModel sub,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE sub_orders SET shipping_provider=@ShippingProvider,provider_order_id=@ProviderOrderId,provider_shipment_id=@ProviderShipmentId,label_url=@LabelUrl WHERE id=@Id",sub);
}
