using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;
namespace BAL;
public partial interface ISellerHubBAL
{
    Task<JsonArray> CouponsAsync(SellerModel seller);
    Task<JsonObject> CouponAsync(UserModel user,SellerModel seller,Guid? id,SellerCouponIn body);
}
public partial class SellerHubBAL
{
    public async Task<JsonArray> CouponsAsync(SellerModel s)=>new((await db.QueryAsync<CouponModel>("SELECT * FROM coupons WHERE seller_id=@sid ORDER BY created_at DESC",new{sid=s.Id})).Select(c=>(JsonNode)CouponAdminBAL.AdminOut(c)).ToArray());
    public async Task<JsonObject> CouponAsync(UserModel user,SellerModel s,Guid? id,SellerCouponIn b)
    {
        await using var tx=await db.BeginAsync();CouponModel c;
        if(id is {} cid)c=await tx.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE id=@cid AND seller_id=@sid FOR UPDATE",new{cid,sid=s.Id})??throw new NotFoundException("Coupon");
        else c=new(){Id=Guid.NewGuid(),SellerId=s.Id,FundedBy="seller",Code=b.Code.ToUpperInvariant(),IsActive=true,ShowOnCheckout=true,CreatedAt=DateTimeFunctions.UtcNow()};
        CouponAdminBAL.CheckValues(b.Kind,b.Value!.Value);
        if(id is null&&await tx.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM coupons WHERE UPPER(code)=@Code)",new{c.Code}))throw new ConflictException("This code is already used","code_taken");
        c.Description=b.Description;c.Kind=b.Kind;c.Value=b.Value.Value;c.MaxDiscountPaise=b.MaxDiscountPaise;c.MinOrderPaise=b.MinOrderPaise;c.StartsAt=b.StartsAt;c.EndsAt=b.EndsAt;c.UsageLimit=b.UsageLimit;c.PerUserLimit=b.PerUserLimit;c.IsActive=b.IsActive;c.UpdatedAt=DateTimeFunctions.UtcNow();
        if(id is null)
        {
            await tx.ExecuteAsync("INSERT INTO coupons(code,description,kind,value,max_discount_paise,min_order_paise,starts_at,ends_at,usage_limit,per_user_limit,used_count,funded_by,seller_id,category_id,first_order_only,is_active,show_on_checkout,id,created_at,updated_at)VALUES(@Code,@Description,@Kind,@Value,@MaxDiscountPaise,@MinOrderPaise,@StartsAt,@EndsAt,@UsageLimit,@PerUserLimit,@UsedCount,@FundedBy,@SellerId,@CategoryId,@FirstOrderOnly,@IsActive,@ShowOnCheckout,@Id,@CreatedAt,@UpdatedAt)",c);
            await audit.AuditAsync(user,"coupon.create","coupon",c.Code,uow:tx);
        }
        else await tx.ExecuteAsync("UPDATE coupons SET description=@Description,kind=@Kind,value=@Value,max_discount_paise=@MaxDiscountPaise,min_order_paise=@MinOrderPaise,starts_at=@StartsAt,ends_at=@EndsAt,usage_limit=@UsageLimit,per_user_limit=@PerUserLimit,is_active=@IsActive,updated_at=@UpdatedAt WHERE id=@Id",c);
        await tx.CommitAsync();return CouponAdminBAL.AdminOut(c);
    }
}
