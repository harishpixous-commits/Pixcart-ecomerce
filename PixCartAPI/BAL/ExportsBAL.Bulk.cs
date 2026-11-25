using System.Globalization;
using System.IO.Compression;
using System.Text.Json;
using Model.DomainModel;
using Utils;
namespace BAL;
public sealed partial class ExportsBAL
{
    public async Task AuthorizeBulkAsync(UserModel user,IReadOnlyList<Plan> plans)
    {
        await using var tx=await db.BeginAsync();await rate.RateLimitAsync("export:"+user.Id,30,600,tx);
        await audit.InsertAsync(new(){Id=Guid.NewGuid(),ActorUserId=user.Id,Action="export.bulk",EntityType="export",EntityId="bulk",Detail=JsonSerializer.Serialize(plans.Select(p=>p.Spec.Name+"."+p.Format)),CreatedAt=DateTimeFunctions.UtcNow()},tx.Transaction);await tx.CommitAsync();
    }
    public async Task<Download> BulkAsync(UserModel user,IReadOnlyList<Plan> plans,string brand,CancellationToken ct=default)
    {
        var file=new FileStream(Path.Combine(Path.GetTempPath(),"pixcart-bulk-"+Guid.NewGuid().ToString("N")+".zip"),FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None,256*1024,FileOptions.DeleteOnClose|FileOptions.SequentialScan);
        try
        {
            var manifest=new List<IReadOnlyList<object?>>{new object?[]{"#","File","Export","Format","Filters"}};
            using(var archive=new ZipArchive(file,ZipArchiveMode.Create,leaveOpen:true))
            {
                for(var i=0;i<plans.Count;i++)
                {
                    ct.ThrowIfCancellationRequested();var plan=plans[i];var rendered=await RenderAsync(user,plan,brand,ct);var name=(i+1).ToString("D"+plans.Count.ToString(Inv).Length,Inv)+"-"+rendered.Name;
                    using(var output=archive.CreateEntry(name,CompressionLevel.Fastest).Open())
                    {
                        if(rendered.Bytes is not null)await output.WriteAsync(rendered.Bytes,ct);
                        else if(rendered.Stream is not null){await using var source=rendered.Stream;await source.CopyToAsync(output,ct);}
                        else await foreach(var chunk in rendered.Chunks!.WithCancellation(ct))await output.WriteAsync(chunk,ct);
                    }
                    manifest.Add(new object?[]{i+1,name,plan.Spec.Label,plan.Format.ToUpperInvariant(),string.Join("; ",ExportDefinitions.Summary(plan.Spec,plan.Context,await NamesAsync(plan.Context)).Select(k=>k.Key+": "+k.Value))});
                }
                using var manifestOutput=archive.CreateEntry("MANIFEST.csv",CompressionLevel.Fastest).Open();await manifestOutput.WriteAsync(new byte[]{0xef,0xbb,0xbf},ct);await manifestOutput.WriteAsync(ExportCsv.Encode(manifest),ct);
            }
            await file.FlushAsync(ct);file.Position=0;
            var slug=System.Text.RegularExpressions.Regex.Replace(brand.ToLowerInvariant(),"[^a-z0-9]+","-").Trim('-');if(slug.Length==0)slug="export";
            var now=TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow,TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata"));return new(slug+"-reports-"+now.ToString("yyyy-MM-dd-HHmm",Inv)+".zip","application/zip",Stream:file);
        }
        catch{await file.DisposeAsync();throw;}
    }
    private static readonly CultureInfo Inv=CultureInfo.InvariantCulture;
}
