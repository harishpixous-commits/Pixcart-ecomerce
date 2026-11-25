using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.CustomeAttributes;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public partial interface ISellerHubBAL
{
    JsonObject Preferences(SellerModel seller);
    Task<JsonObject> PreferencesAsync(UserModel user,SellerModel seller,int days,bool holiday,string prefix,string? cutoff);
    Task<JsonArray> WarehousesAsync(SellerModel seller);
    Task<JsonArray> WarehouseAsync(UserModel user,SellerModel seller,Guid? id,JsonObject body);
}
public partial class SellerHubBAL(IMySqlDapperHelper db,IInventoryBAL stock,InventoryDAL inventory,CatalogDAL catalog,IAuditBAL audit,IPlatformSettingsBAL platform,OrdersDAL orders,BAL.Interface.IPayoutsBAL payouts):ISellerHubBAL
{
    public JsonObject Preferences(SellerModel s)=>new(){["dispatch_days"]=s.DispatchDays,["holiday_mode"]=s.HolidayMode,["invoice_prefix"]=s.InvoicePrefix,["dispatch_cutoff"]=s.DispatchCutoff,["rating_avg"]=s.RatingAvg,["rating_count"]=s.RatingCount};
    public async Task<JsonObject> PreferencesAsync(UserModel user,SellerModel s,int days,bool holiday,string prefix,string? cutoff)
    {
        if(days is <0 or >10||prefix is null||!Regex.IsMatch(prefix,"^[A-Z0-9]{0,4}$")||cutoff is not null&&!Regex.IsMatch(cutoff,@"^((?:[01]\d|2[0-3]):[0-5]\d)?$"))throw new AppException("Invalid preferences","validation",422);
        s.DispatchDays=days;s.HolidayMode=holiday;s.InvoicePrefix=prefix;if(cutoff is not null)s.DispatchCutoff=cutoff;
        await using var tx=await db.BeginAsync();await tx.ExecuteAsync("UPDATE sellers SET dispatch_days=@DispatchDays,holiday_mode=@HolidayMode,invoice_prefix=@InvoicePrefix,dispatch_cutoff=@DispatchCutoff,updated_at=UTC_TIMESTAMP(6) WHERE id=@Id",s);
        await audit.AuditAsync(user,"seller.preferences","seller",s.Id,"holiday="+(holiday?"True":"False"),tx);await tx.CommitAsync();return Preferences(s);
    }
    private async Task<JsonArray> SummaryAsync(Guid sid)
    {
        var rows=await db.QueryAsync<WarehouseModel>("SELECT * FROM warehouses WHERE seller_id=@sid ORDER BY is_default DESC,code",new{sid});var result=new JsonArray();
        foreach(var w in rows)
        {
            var units=await db.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(quantity),0) FROM inventory_levels WHERE warehouse_id=@id",new{id=w.Id});var skus=await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM inventory_levels WHERE warehouse_id=@id",new{id=w.Id});
            result.Add(new JsonObject{["id"]=w.Id.ToString(),["code"]=w.Code,["name"]=w.Name,["line1"]=w.Line1,["line2"]=w.Line2,["city"]=w.City,["state_code"]=w.StateCode,["pincode"]=w.Pincode,["contact_name"]=w.ContactName,["contact_phone"]=w.ContactPhone,["gstin"]=w.Gstin,["is_default"]=w.IsDefault,["is_active"]=w.IsActive,["units"]=units,["skus"]=skus});
        }
        return result;
    }
    public async Task<JsonArray> WarehousesAsync(SellerModel s){await stock.DefaultWarehouseAsync(s);return await SummaryAsync(s.Id);}
    private static string Text(JsonObject b,string k,int min,int max,string? fallback=null)
    {var value=b[k]?.GetValue<string>()??fallback??throw new AppException(k+" is required","validation",422);if(value.Length<min||value.Length>max)throw new AppException("Invalid "+k,"validation",422);return value;}
    public async Task<JsonArray> WarehouseAsync(UserModel user,SellerModel s,Guid? id,JsonObject b)
    {
        WarehouseModel body;
        try
        {
            var code=Text(b,"code",2,20);if(!Regex.IsMatch(code,@"^[A-Za-z0-9\-]+$"))throw new ArgumentException("Invalid code");
            var phone=Text(b,"contact_phone",0,100,"");var gst=Text(b,"gstin",0,100,"");
            body=new(){Id=id??Guid.NewGuid(),SellerId=s.Id,Code=code.ToUpperInvariant(),Name=Text(b,"name",2,80),Line1=Text(b,"line1",3,200),Line2=Text(b,"line2",0,200,""),City=Text(b,"city",2,80),StateCode=IndianFormats.ValidateStateCode(Text(b,"state_code",1,10)),Pincode=IndianFormats.ValidatePincode(Text(b,"pincode",1,20)),ContactName=Text(b,"contact_name",0,120,""),ContactPhone=phone.Length>0?IndianFormats.NormalizeMobile(phone):"",Gstin=gst.Length>0?IndianFormats.ValidateGstin(gst):"",IsActive=b["is_active"]?.GetValue<bool>()??true};
        }catch(Exception e)when(e is ArgumentException or InvalidOperationException){throw new AppException(e.Message,"validation",422);}
        await using(var tx=await db.BeginAsync())
        {
            WarehouseModel? old=null;
            if(id is {} wid){old=await tx.QueryFirstOrDefaultAsync<WarehouseModel>("SELECT * FROM warehouses WHERE id=@wid AND seller_id=@sid FOR UPDATE",new{wid,sid=s.Id})??throw new NotFoundException("Warehouse");}
            if(old is null)
            {
                if(await tx.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM warehouses WHERE seller_id=@sid AND UPPER(code)=@Code)",new{sid=s.Id,body.Code}))throw new ConflictException("Another warehouse already uses this code","code_taken");
                if(await tx.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM warehouses WHERE seller_id=@sid",new{sid=s.Id})>=20)throw new AppException("You can add up to 20 warehouses","warehouse_limit");
            }
            else if(old.IsDefault&&(body.StateCode!=old.StateCode||body.Pincode!=old.Pincode||body.Line1!=old.Line1))throw new AppException("The main warehouse follows your verified pickup address; contact seller support to change it","default_locked");
            else if(old.IsDefault&&!body.IsActive)throw new AppException("The main warehouse cannot be switched off","default_locked");
            if(!string.IsNullOrEmpty(s.Gstin)&&body.StateCode!=s.Gstin[..2])
            {
                if(body.Gstin.Length==0)throw new AppException("This warehouse is in a different state from your GSTIN. Enter your GSTIN for that state.","gstin_required",fields:new Dictionary<string,string>{{"gstin","Required"}});
                if(body.Gstin[..2]!=body.StateCode||body.Gstin.Substring(2,10)!=s.Gstin.Substring(2,10))throw new AppException("The GSTIN must belong to this state and to your PAN","gstin_mismatch",fields:new Dictionary<string,string>{{"gstin","Does not match"}});
            }
            if(old is null)await inventory.InsertWarehouseAsync(body,tx);
            else
            {
                body.Code=old.Code;
                await tx.ExecuteAsync("UPDATE warehouses SET name=@Name,line1=@Line1,line2=@Line2,city=@City,state_code=@StateCode,pincode=@Pincode,contact_name=@ContactName,contact_phone=@ContactPhone,gstin=@Gstin,is_active=@IsActive,updated_at=UTC_TIMESTAMP(6) WHERE id=@Id",body);
                if(old.IsActive!=body.IsActive)
                {
                    var variants=await tx.QueryAsync<VariantModel>("SELECT v.* FROM variants v JOIN inventory_levels l ON l.variant_id=v.id WHERE l.warehouse_id=@id ORDER BY v.id FOR UPDATE",new{id=body.Id});
                    foreach(var v in variants){await inventory.SetVariantStockAsync(v.Id,await inventory.VariantStockTotalAsync(v.Id,tx),tx);await catalog.RefreshAggregatesAsync(v.ProductId,tx);}
                }
            }
            await audit.AuditAsync(user,old is null?"warehouse.create":"warehouse.update","seller",s.Id,old is null?Text(b,"code",2,20):old.Code+(old.IsActive==body.IsActive?"":body.IsActive?" switched on":" switched off"),tx);await tx.CommitAsync();
        }
        return await SummaryAsync(s.Id);
    }
}
