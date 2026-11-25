using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

public sealed partial class ExportsBAL(ExportsDAL data, IAccessBAL access, IRateLimitBAL rate, AuditDAL audit,
    IMySqlDapperHelper db, ISiteBAL site, ITcsReportBAL tcs)
{
    public sealed record Plan(ExportDefinitions.Spec Spec,string Format,ExportDefinitions.Context Context,IReadOnlyList<int> Columns);
    public sealed record Download(string Name,string ContentType,IAsyncEnumerable<byte[]>? Chunks=null,Stream? Stream=null,byte[]? Bytes=null);
    public async Task<JsonObject> ListAsync(UserModel user,bool seller)
    {
        var perms=seller?new HashSet<string>():await access.PermissionsForAsync(user);
        return new(){["items"]=new JsonArray(ExportDefinitions.All.Where(s=>s.Scope==(seller?"seller":"admin")&&(seller||perms.Contains(s.Permission))).Select(s=>(JsonNode)ExportDefinitions.Describe(s)).ToArray()),["max_days"]=ExportDefinitions.MaxRangeDays};
    }
    public async Task<Plan> PlanAsync(UserModel user,bool seller,string name,string format,Guid? sellerId,DateOnly? from,DateOnly? to,string? status,string? month,IReadOnlyDictionary<string,string?> extra,IReadOnlyList<string> columns,bool bulk=false)
    {
        var spec=ExportDefinitions.All.FirstOrDefault(s=>s.Name==name&&s.Scope==(seller?"seller":"admin"))??throw new NotFoundException(bulk?"Export "+name:"Export");
        if(!seller&&!(await access.PermissionsForAsync(user)).Contains(spec.Permission))throw new ForbiddenException(bulk?$"Your role does not allow the {spec.Label} export ({spec.Permission})":$"Your role does not allow this export ({spec.Permission})");
        if(!ExportDefinitions.Formats.Contains(format)){if(bulk)throw new AppException(spec.Label+": format must be csv, xlsx or pdf","invalid_export_filter");throw new NotFoundException("Export format");}
        try{return new(spec,format,ExportDefinitions.Parse(spec,sellerId,from,to,status,month,extra),ExportDefinitions.PickColumns(spec,columns,format));}
        catch(ArgumentException e){throw new AppException((bulk?spec.Label+": ":"")+e.Message,"invalid_export_filter");}
    }
    public async Task AuthorizeReadAsync(UserModel user,Plan plan,string scope)
    {
        await using var tx=await db.BeginAsync();await rate.RateLimitAsync("export:"+user.Id,30,600,tx);
        await audit.InsertAsync(new(){Id=Guid.NewGuid(),ActorUserId=user.Id,Action="export."+plan.Spec.Name,EntityType="export",EntityId=plan.Spec.Name,CreatedAt=DateTimeFunctions.UtcNow(),Detail=JsonSerializer.Serialize(new{format=plan.Format,from=plan.Context.Start?.ToOffset(TimeSpan.FromMinutes(330)).ToString("yyyy-MM-dd")??"",to=plan.Context.End?.ToOffset(TimeSpan.FromMinutes(330)).AddDays(-1).ToString("yyyy-MM-dd")??"",status=plan.Context.Status??"",month=plan.Context.Month??"",filters=plan.Context.Extra.ToDictionary(k=>k.Key,k=>Convert.ToString(k.Value,System.Globalization.CultureInfo.InvariantCulture)??""),columns=plan.Columns.Count,scope})},tx.Transaction);
        await tx.CommitAsync();
    }
    public async Task<string> BrandAsync()=>(await site.GetSiteAsync())["brand_name"]?.GetValue<string>()??"";
    private async Task<IReadOnlyDictionary<string,string>> NamesAsync(ExportDefinitions.Context context)
    {
        var names=new Dictionary<string,string>();foreach(var key in new[]{"seller","category"})if(context.Extra.TryGetValue(key,out var value))names[key]=await db.ExecuteScalarAsync<string>(key=="seller"?"SELECT display_name FROM sellers WHERE id=@id":"SELECT name FROM categories WHERE id=@id",new{id=value.ToString()})??"";return names;
    }
    private async IAsyncEnumerable<IReadOnlyList<object?>> Rows(UserModel user,Plan p,[EnumeratorCancellation]CancellationToken ct=default)
    {
        if(p.Spec.NeedsMonth)
        {
            var result=await tcs.ReadAsync(user,p.Context.Month!);
            string Money(JsonNode? v)=>(v?.GetValue<long>()/100m??0).ToString("F2",System.Globalization.CultureInfo.InvariantCulture);
            foreach(var item in result["items"]!.AsArray())yield return new object?[]{item!["gstin"]!.GetValue<string>(),item["legal_name"]!.GetValue<string>(),item["sub_orders"]!.GetValue<long>(),Money(item["returned_value"]),Money(item["net_taxable_value"]),Money(item["igst_tcs"]),Money(item["cgst_tcs"]),Money(item["sgst_tcs"])};
            yield break;
        }
        await foreach(var row in data.RowsAsync(p.Spec,p.Context,ct))yield return row;
    }
    private async IAsyncEnumerable<byte[]> Csv(UserModel user,Plan p,[EnumeratorCancellation]CancellationToken ct=default)
    {
        yield return new byte[]{0xef,0xbb,0xbf}.Concat(ExportCsv.Encode([p.Columns.Select(i=>(object?)p.Spec.Headers[i]).ToList()])).ToArray();
        var batch=new List<IReadOnlyList<object?>>(ExportDefinitions.Batch);
        await foreach(var row in Rows(user,p,ct))
        {
            batch.Add(ExportCsv.Pick(row,p.Columns));
            if(batch.Count>=ExportDefinitions.Batch){yield return ExportCsv.Encode(batch);batch.Clear();}
        }
        if(batch.Count>0)yield return ExportCsv.Encode(batch);
    }
    private async IAsyncEnumerable<IReadOnlyList<object?>> Selected(UserModel user,Plan p,[EnumeratorCancellation]CancellationToken ct=default)
    {await foreach(var row in Rows(user,p,ct))yield return ExportCsv.Pick(row,p.Columns);}
    public async Task<Download> RenderAsync(UserModel user,Plan p,string brand,CancellationToken ct=default)
    {
        var name=ExportDefinitions.FileName(brand,p.Spec,p.Context,p.Format);var headers=p.Columns.Select(i=>p.Spec.Headers[i]).ToList();
        if(p.Format=="csv")return new(name,"text/csv; charset=utf-8",Chunks:Csv(user,p,ct));
        var about=ExportDefinitions.Summary(p.Spec,p.Context,await NamesAsync(p.Context));var title=brand+" \u2014 "+p.Spec.Label;
        if(p.Format=="xlsx")
        {
            var details=new List<(string,string)>{("Export",p.Spec.Label)};details.AddRange(about);details.Add(("Generated by",user.Name.Length>0?user.Name:user.Email??""));
            return new(name,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",Stream:await StreamingWorkbook.BuildAsync(p.Spec.Label,headers,Selected(user,p,ct),title,details,ct));
        }
        var shown=new List<IReadOnlyList<string>>();var total=0;
        await foreach(var row in Selected(user,p,ct)){total++;if(shown.Count<ReportPdf.MaxRows)shown.Add(row.Select(v=>v is bool b?b?"True":"False":Convert.ToString(v,System.Globalization.CultureInfo.InvariantCulture)??"").ToList());}
        var blocks=new List<ReportPdf.Block>{new("table",Columns:headers,Rows:shown,TotalRows:total)};if(total==0)blocks.Add(new("note","No rows match these filters."));
        return new(name,"application/pdf",Bytes:ReportPdf.Build(title,string.Join(" · ",about.Select(k=>k.Key+": "+k.Value)),brand,blocks));
    }
    public async Task<JsonObject> LookupAsync(string kind,string query)
    {
        var sql=kind switch{"seller"=>"SELECT id value,display_name label FROM sellers WHERE display_name LIKE @q OR legal_name LIKE @q ORDER BY display_name LIMIT 50","category"=>"SELECT id value,name label FROM categories WHERE name LIKE @q ORDER BY name LIMIT 50",_=>throw new NotFoundException("Filter")};
        var rows=await db.QueryAsync<Lookup>(sql,new{q="%"+query.Trim()+"%"});return new(){["items"]=new JsonArray(rows.Select(r=>(JsonNode)new JsonObject{["value"]=r.Value.ToString(),["label"]=r.Label}).ToArray())};
    }
    private sealed class Lookup{public Guid Value{get;set;}public string Label{get;set;}="";}
}
