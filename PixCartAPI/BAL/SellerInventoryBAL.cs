using BAL.Interface;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.VisualBasic.FileIO;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public partial interface ISellerHubBAL
{
    Task<JsonObject> InventoryAsync(SellerModel seller,string query,bool low,int page);
    Task<JsonObject> AdjustAsync(UserModel user,SellerModel seller,Guid variant,Guid warehouse,string mode,int quantity,string note);
    Task<JsonObject> TransferAsync(UserModel user,SellerModel seller,Guid variant,Guid from,Guid to,int quantity);
    Task<JsonObject> MovementsAsync(SellerModel seller,Guid variant);
    Task<JsonObject> ImportStockAsync(UserModel user,SellerModel seller,byte[] data);
}
public partial class SellerHubBAL
{
    private sealed class GridRow:VariantModel { public string Title{get;set;}=""; }
    private sealed class MovementRow:StockMovementModel { public string Code{get;set;}=""; }
    public async Task<JsonObject> InventoryAsync(SellerModel s,string query,bool low,int page)
    {
        var threshold=(await platform.GetAsync()).Int("low_stock_threshold");
        var warehouses=(await db.QueryAsync<WarehouseModel>("SELECT * FROM warehouses WHERE seller_id=@sid ORDER BY is_default DESC,code",new{sid=s.Id})).ToList();
        const string filter="v.seller_id=@sid AND p.status<>'archived' AND (@q='' OR p.title LIKE @like OR v.sku LIKE @like) AND (@low=0 OR (v.stock<=@threshold AND v.is_active=1))";
        var args=new{sid=s.Id,q=query.Trim(),like="%"+query.Trim()+"%",low,threshold,offset=(long)(page-1)*50};
        var count=await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM variants v JOIN products p ON p.id=v.product_id WHERE "+filter,args);
        var rows=(await db.QueryAsync<GridRow>("SELECT v.*,p.title FROM variants v JOIN products p ON p.id=v.product_id WHERE "+filter+" ORDER BY p.title,v.sku LIMIT 50 OFFSET @offset",args)).ToList();
        var ids=rows.Select(v=>v.Id).ToList();var levels=ids.Count==0?[]:(await db.QueryAsync<InventoryLevelModel>("SELECT * FROM inventory_levels WHERE variant_id IN @ids",new{ids})).ToList();
        return new JsonObject{["warehouses"]=new JsonArray(warehouses.Select(w=>(JsonNode)new JsonObject{["id"]=w.Id.ToString(),["code"]=w.Code,["name"]=w.Name,["is_active"]=w.IsActive}).ToArray()),
            ["items"]=new JsonArray(rows.Select(v=>(JsonNode)new JsonObject{["variant_id"]=v.Id.ToString(),["product_id"]=v.ProductId.ToString(),["title"]=v.Title,["sku"]=v.Sku,["label"]=string.Join(" / ",(JsonNode.Parse(v.Options) as JsonObject??[]).Select(kv=>$"{kv.Key}: {kv.Value?.GetValue<string>()}")),["total"]=v.Stock,["is_active"]=v.IsActive,["levels"]=new JsonObject(warehouses.Select(w=>new KeyValuePair<string,JsonNode?>(w.Id.ToString(),JsonValue.Create(levels.FirstOrDefault(l=>l.VariantId==v.Id&&l.WarehouseId==w.Id)?.Quantity??0))))}).ToArray()),
            ["total"]=count,["page"]=page,["page_size"]=50,["low_stock_threshold"]=threshold};
    }
    private async Task<VariantModel> OwnedVariantAsync(Guid sid,Guid vid,IUnitOfWork? tx=null)
    {
        var v=tx is null?await db.QueryFirstOrDefaultAsync<VariantModel>("SELECT * FROM variants WHERE id=@vid",new{vid}):await tx.QueryFirstOrDefaultAsync<VariantModel>("SELECT * FROM variants WHERE id=@vid FOR UPDATE",new{vid});
        return v is not null&&v.SellerId==sid?v:throw new NotFoundException("Product option");
    }
    private static async Task<WarehouseModel> OwnedWarehouseAsync(Guid sid,Guid wid,IUnitOfWork tx)
    {var w=await tx.QueryFirstOrDefaultAsync<WarehouseModel>("SELECT * FROM warehouses WHERE id=@wid",new{wid});return w is not null&&w.SellerId==sid?w:throw new NotFoundException("Warehouse");}
    public async Task<JsonObject> AdjustAsync(UserModel user,SellerModel s,Guid vid,Guid wid,string mode,int quantity,string note)
    {
        await using var tx=await db.BeginAsync();var v=await OwnedVariantAsync(s.Id,vid,tx);var w=await OwnedWarehouseAsync(s.Id,wid,tx);
        var qty=mode=="set"?await stock.SetQuantityAsync(v,w.Id,quantity,user.Id,note,tx):await stock.ChangeAsync(v,w.Id,mode=="add"?quantity:-quantity,"adjust",note:note,actorId:user.Id,uow:tx);
        await catalog.RefreshAggregatesAsync(v.ProductId,tx);await tx.CommitAsync();return new JsonObject{["variant_id"]=v.Id.ToString(),["warehouse_id"]=w.Id.ToString(),["quantity"]=qty,["total"]=v.Stock};
    }
    public async Task<JsonObject> TransferAsync(UserModel user,SellerModel s,Guid vid,Guid from,Guid to,int quantity)
    {
        if(from==to)throw new AppException("Choose two different warehouses","same_warehouse");
        await using var tx=await db.BeginAsync();var v=await OwnedVariantAsync(s.Id,vid,tx);var a=await OwnedWarehouseAsync(s.Id,from,tx);var b=await OwnedWarehouseAsync(s.Id,to,tx);
        await stock.ChangeAsync(v,a.Id,-quantity,"transfer",reference:"to "+b.Code,actorId:user.Id,uow:tx);await stock.ChangeAsync(v,b.Id,quantity,"transfer",reference:"from "+a.Code,actorId:user.Id,uow:tx);
        // Source transfer commits without refreshing product aggregates. Preserve that behavior pending owner decision.
        await tx.CommitAsync();return new JsonObject{["ok"]=true,["total"]=v.Stock};
    }
    public async Task<JsonObject> MovementsAsync(SellerModel s,Guid vid)
    {
        await OwnedVariantAsync(s.Id,vid);var rows=await db.QueryAsync<MovementRow>("SELECT m.*,w.code FROM stock_movements m JOIN warehouses w ON w.id=m.warehouse_id WHERE m.variant_id=@vid ORDER BY m.created_at DESC LIMIT 100",new{vid});
        return new JsonObject{["items"]=new JsonArray(rows.Select(m=>(JsonNode)new JsonObject{["at"]=DateTimeFunctions.Iso(m.CreatedAt),["warehouse"]=m.Code,["kind"]=m.Kind,["delta"]=m.Delta,["balance"]=m.BalanceAfter,["reference"]=m.Reference,["note"]=m.Note}).ToArray())};
    }
    public async Task<JsonObject> ImportStockAsync(UserModel user,SellerModel s,byte[] data)
    {
        var raw=Encoding.UTF8.GetString(data).TrimStart('\ufeff');if(raw.Length>2*1024*1024)throw new AppException("The file is larger than 2 MB","file_too_large");
        using var parser=new TextFieldParser(new StringReader(raw)){TextFieldType=FieldType.Delimited,HasFieldsEnclosedInQuotes=true,TrimWhiteSpace=false};parser.SetDelimiters(",");
        var head=parser.EndOfData?[]:parser.ReadFields()!.Select(h=>h.Trim().ToLowerInvariant()).ToArray();if(!new[]{"sku","warehouse_code","quantity"}.All(head.Contains))throw new AppException("The CSV needs the columns sku, warehouse_code and quantity","bad_csv");
        await using var tx=await db.BeginAsync();var warehouses=(await tx.QueryAsync<WarehouseModel>("SELECT * FROM warehouses WHERE seller_id=@sid",new{sid=s.Id})).ToDictionary(w=>w.Code.ToUpperInvariant());var errors=new JsonArray();var touched=new HashSet<Guid>();var updated=0;var n=1;
        void Error(string message){if(errors.Count<200)errors.Add(new JsonObject{["row"]=n,["error"]=message});}
        while(!parser.EndOfData)
        {
            n++;if(n>5001){Error("Only 5000 rows per file");break;}string[] fields;try{fields=parser.ReadFields()!;}catch(MalformedLineException){Error("Invalid CSV row");continue;}
            var row=new Dictionary<string,string>();for(var i=0;i<head.Length;i++)row[head[i]]=i<fields.Length?fields[i].Trim():"";var qty=row["quantity"];
            if(!Regex.IsMatch(qty,@"^\d{1,7}$")){Error("Quantity must be a whole number");continue;}
            if(!warehouses.TryGetValue(row["warehouse_code"].ToUpperInvariant(),out var w)){Error("Unknown warehouse code "+row["warehouse_code"]);continue;}
            var v=await tx.QueryFirstOrDefaultAsync<VariantModel>("SELECT * FROM variants WHERE seller_id=@sid AND LOWER(sku)=LOWER(@sku) FOR UPDATE",new{sid=s.Id,sku=row["sku"]});if(v is null){Error("Unknown SKU "+row["sku"]);continue;}
            await stock.SetQuantityAsync(v,w.Id,int.Parse(qty),user.Id,"CSV import",tx);touched.Add(v.ProductId);updated++;
        }
        foreach(var pid in touched)await catalog.RefreshAggregatesAsync(pid,tx);await tx.CommitAsync();return new JsonObject{["updated"]=updated,["errors"]=errors};
    }
}
