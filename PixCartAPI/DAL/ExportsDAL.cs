using System.Data;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Dapper;
using Model.Constants;
using MySqlConnector;
using Utils;

namespace DAL;

/// <summary>Export-only forward reader. Opens its own connection, so response streams do not retain a request transaction.</summary>
public sealed partial class ExportsDAL(AppSettings settings)
{
    private sealed record Field(string Sql, string Format = "");
    private sealed record Plan(string From, IReadOnlyList<Field> Fields, string OrderBy, string? Date = null,
        string? Seller = null, string? Status = null, string? Category = null, string? Payment = null,
        IReadOnlyList<string>? Search = null, string? Stock = null, string? BaseWhere = null);
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private static Plan Catalogue(bool stock) => stock
        ? new("variants v JOIN products p ON p.id=v.product_id JOIN inventory_levels i ON i.variant_id=v.id JOIN warehouses w ON w.id=i.warehouse_id JOIN sellers s ON s.id=v.seller_id",
            [new("v.sku"),new("w.code"),new("i.quantity"),new("p.title"),new("v.options","options"),new("s.display_name"),new("w.name"),new("v.is_active","bool")],
            "s.display_name,p.title,v.sku,w.code",Seller:"v.seller_id",Category:"p.category_id",Search:["v.sku","p.title"],Stock:"i.quantity",BaseWhere:"p.status<>'archived'")
        : new("products p JOIN variants v ON v.product_id=p.id JOIN sellers s ON s.id=p.seller_id JOIN categories c ON c.id=p.category_id",
            [new("v.sku"),new("p.title"),new("v.options","options"),new("s.display_name"),new("c.name"),new("p.brand"),new("p.status"),new("v.mrp_paise","money"),new("v.price_paise","money"),new("v.stock"),new("p.hsn_code"),new("p.gst_bps","pct"),new("p.return_window_days"),new("p.rating_avg","rating"),new("p.rating_count"),new("p.sold_count"),new("p.created_at","ist")],
            "s.display_name,p.title,v.sku",Seller:"p.seller_id",Status:"p.status",Category:"p.category_id",Search:["v.sku","p.title","p.brand"],Stock:"v.stock");
    private static Plan Packages(bool items) => items
        ? new("order_items i JOIN sub_orders p ON p.id=i.sub_order_id JOIN orders o ON o.id=p.order_id JOIN sellers s ON s.id=p.seller_id",
            [new("p.number"),new("p.created_at","ist"),new("p.status"),new("p.invoice_number"),new("p.invoice_date","date"),new("s.legal_name"),new("s.gstin"),new("o.ship_to","supply"),new("p.is_interstate","bool"),new("i.sku"),new("i.title"),new("i.variant_label"),new("i.hsn_code"),new("i.qty"),new("i.unit_price","money"),new("i.line_total","money"),new("i.seller_discount","money"),new("i.platform_discount","money"),new("i.taxable_value","money"),new("i.gst_bps","pct"),new("i.cgst","money"),new("i.sgst","money"),new("i.igst","money"),new("i.returned_qty")],
            "p.created_at,p.id,i.id",Date:"p.created_at",Seller:"p.seller_id",Status:"p.status",Payment:"o.payment_method",Search:["p.number","i.sku","i.title"],BaseWhere:"p.status<>'pending_payment'")
        : new("sub_orders p JOIN orders o ON o.id=p.order_id JOIN sellers s ON s.id=p.seller_id",
            [new("p.number"),new("o.number"),new("p.created_at","ist"),new("s.display_name"),new("s.gstin"),new("p.status"),new("o.payment_method"),new("o.payment_status"),new("o.ship_to","state"),new("p.items_total","money"),new("p.shipping_fee","money"),new("p.cod_fee","money"),new("p.seller_discount","money"),new("p.platform_discount","money"),new("p.total","money"),new("p.taxable_total","money"),new("p.commission_paise","money"),new("p.commission_gst_paise","money"),new("p.tcs_paise","money"),new("p.tds_paise","money"),new("p.seller_payout_paise","money"),new("p.returned_total","money"),new("o.coupon_code"),new("p.invoice_number"),new("p.invoice_date","date"),new("p.courier_name"),new("p.tracking_number"),new("p.shipped_at","ist"),new("p.delivered_at","ist"),new("p.cancel_reason")],
            "p.created_at,p.id",Date:"p.created_at",Seller:"p.seller_id",Status:"p.status",Payment:"o.payment_method",Search:["p.number","o.number"],BaseWhere:"p.status<>'pending_payment'");
    private static Plan PlanFor(string name) => name switch
    {
        "products" => Catalogue(false), "stock" => Catalogue(true), "orders" => Packages(false), "order-items" => Packages(true),
        _ => OtherPlan(name),
    };
    private static string Like(string text) => "%" + text.Replace("!","!!").Replace("%","!%").Replace("_","!_") + "%";
    private static (string Sql, DynamicParameters Parameters, IReadOnlyList<Field> Fields) Query(ExportDefinitions.Spec spec, ExportDefinitions.Context context)
    {
        var p=PlanFor(spec.Name); var where=new List<string>();var args=new DynamicParameters();
        if(p.BaseWhere is not null)where.Add(p.BaseWhere);
        if(p.Date is not null && context.Start is not null){where.Add(p.Date+">=@start");args.Add("start",context.Start.Value.UtcDateTime);}
        if(p.Date is not null && context.End is not null){where.Add(p.Date+"<@end");args.Add("end",context.End.Value.UtcDateTime);}
        if(p.Seller is not null && context.SellerId is not null){where.Add(p.Seller+"=@owner");args.Add("owner",context.SellerId.Value.ToString());}
        if(p.Status is not null && context.Status is not null){where.Add(p.Status+"=@status");args.Add("status",context.Status);}
        foreach(var (key,value) in context.Extra)
        {
            var column=key switch{"seller"=>p.Seller,"category"=>p.Category,"payment_method"=>p.Payment,"low_stock"=>p.Stock,_=>null};
            if(column is not null){where.Add(column+(key=="low_stock"?"<=":"=")+"@f_"+key);args.Add("f_"+key,value is Guid id?id.ToString():value);}
            if(key=="q" && p.Search is { Count:>0 }){where.Add("("+string.Join(" OR ",p.Search.Select(c=>c+" LIKE @search ESCAPE '!'"))+")");args.Add("search",Like((string)value));}
        }
        if(p.Fields.Count!=spec.Headers.Count)throw new InvalidOperationException("Export field/header mismatch");
        return ("SELECT "+string.Join(",",p.Fields.Select((f,i)=>f.Sql+" AS c"+i))+" FROM "+p.From+(where.Count>0?" WHERE "+string.Join(" AND ",where):"")+" ORDER BY "+p.OrderBy,args,p.Fields);
    }
    public async IAsyncEnumerable<IReadOnlyList<object?>> RowsAsync(ExportDefinitions.Spec spec, ExportDefinitions.Context context,
        [EnumeratorCancellation] CancellationToken cancellationToken=default)
    {
        var (sql,args,fields)=Query(spec,context);
        var builder=new MySqlConnectionStringBuilder(settings.ConnectionString){GuidFormat=MySqlGuidFormat.Char36,CharacterSet="utf8mb4"};
        await using var connection=new MySqlConnection(builder.ConnectionString);await connection.OpenAsync(cancellationToken);
        using var reader=await connection.ExecuteReaderAsync(new CommandDefinition(sql,args,commandTimeout:300,cancellationToken:cancellationToken));
        var count=0;
        while(await ((System.Data.Common.DbDataReader)reader).ReadAsync(cancellationToken))
        {
            var cells=new object?[fields.Count];
            for(var i=0;i<fields.Count;i++)cells[i]=Format(reader.IsDBNull(i)?null:reader.GetValue(i),fields[i].Format);
            yield return cells;
            if(++count>=ExportDefinitions.MaxRows){yield return new object?[]{"Stopped at 1,000,000 rows; export a shorter date range for the rest."};yield break;}
        }
    }
    private static object? Format(object? value,string kind)
    {
        var s=Convert.ToString(value,Inv)??"";
        if(kind=="jsonstr")return s=="null"?"":s;
        if(kind=="statecode")return IndianStates.Names.GetValueOrDefault(s,"");
        if(kind=="optionalpct")return value is null?"":(Convert.ToDecimal(value,Inv)/100).ToString("G",Inv);
        if(kind=="optionalbool")return value is null?"":Convert.ToBoolean(value,Inv);
        if(kind is "money" or "pct" or "rating")
        {
            var number=value is null?0:Convert.ToDecimal(value,Inv);
            return kind=="rating"?number.ToString("F1",Inv):(number/100).ToString(kind=="money"?"F2":"G",Inv);
        }
        if(kind is "ist" or "date")return value is DateTime dt?DateTime.SpecifyKind(dt,DateTimeKind.Utc).AddMinutes(330).ToString(kind=="date"?"yyyy-MM-dd":"yyyy-MM-dd HH:mm",Inv):"";
        if(kind=="bool")return value is not null&&Convert.ToBoolean(value,Inv);
        if(kind=="options")return JsonNode.Parse(s) is JsonObject o?string.Join(", ",o.Select(p=>p.Key+": "+(p.Value is JsonValue v&&v.TryGetValue<string>(out var text)?text:p.Value?.ToJsonString()??"None"))):"";
        if(kind is "state" or "supply")
        {
            var ship=JsonNode.Parse(s) as JsonObject;var code=ship?["state_code"]?.GetValue<string>()??"";
            return kind=="supply"?(code.Length>0?code+"-"+IndianStates.Names.GetValueOrDefault(code,""):"")
                :IndianStates.Names.GetValueOrDefault(code,ship?["state"]?.GetValue<string>()??"");
        }
        return value??"";
    }
}
