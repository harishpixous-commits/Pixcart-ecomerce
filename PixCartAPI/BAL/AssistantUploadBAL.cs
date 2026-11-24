using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using BAL.Interface;
using DAL;
using Microsoft.VisualBasic.FileIO;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public partial class AssistantUploadBAL(AssistantUploadDAL data,IAccessBAL access,IRateLimitBAL limits,IMySqlDapperHelper db,AuditDAL audit):IAssistantUploadBAL
{
    public const int MaxBytes=5*1024*1024,MaxRows=50000,MaxCols=100,TextLimit=200000;
    private static AppException Bad(string text)=>new(text,"bad_upload");
    private static readonly string[] Extensions=[".csv",".tsv",".xlsx",".txt",".md",".json"];
    private static string Cut(string s,int length)=>s[..Math.Min(s.Length,length)];
    private static string Str(JsonNode? n)=>n is JsonValue v&&v.TryGetValue<string>(out var s)?s:n is JsonValue b&&b.TryGetValue<bool>(out var yes)?(yes?"True":"False"):n?.ToJsonString()??"";
    private static JsonNode Cell(JsonNode? n)=>n is null?JsonValue.Create("")!:n is JsonObject or JsonArray?JsonValue.Create(Cut(PythonJson(n,null,true),500))!:n is JsonValue v&&v.TryGetValue<string>(out var text)?JsonValue.Create(text.Trim())!:n.DeepClone();
    private static void Table(AssistantUploadModel up,List<string> header,List<JsonArray> rows,bool truncated)
    {
        var width=Math.Max(header.Count,rows.Take(1000).Select(r=>r.Count).DefaultIfEmpty(0).Max());var names=new List<string>();var seen=new Dictionary<string,int>();for(var i=0;i<width;i++){var name=Cut(Regex.Replace(i<header.Count?header[i].Trim():"",@"\s+"," "),80);if(name.Length==0)name=$"Column {i+1}";seen[name]=seen.GetValueOrDefault(name)+1;names.Add(seen[name]>1?$"{name} ({seen[name]})":name);}if(names.Count==0)throw Bad("The file has no header row.");foreach(var row in rows)while(row.Count<width)row.Add("");up.Columns=JsonSerializer.Serialize(names);up.Rows=new JsonArray(rows.Select(r=>(JsonNode)r).ToArray()).ToJsonString();up.RowCount=rows.Count;up.Truncated=truncated;up.Text="";
    }
    private static string ColumnName(XElement c)=>Regex.Match(c.Attribute("r")?.Value??"A1","^[A-Za-z]+").Value;
    private static int ColumnIndex(string name){var n=0;foreach(var c in name.ToUpperInvariant())n=n*26+c-'A'+1;return n-1;}
    // XLSX values are read from cached XML, formulas are never evaluated and macros are not accepted.
    private static void Excel(AssistantUploadModel up,byte[] bytes)
    {
        if(bytes.Length<2||bytes[0]!='P'||bytes[1]!='K')throw Bad("This is not a valid Excel file.");try
        {
            using var zip=new ZipArchive(new MemoryStream(bytes),ZipArchiveMode.Read);XNamespace ns="http://schemas.openxmlformats.org/spreadsheetml/2006/main";XNamespace rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships";XDocument Xml(string path){using var stream=(zip.GetEntry(path)??throw new InvalidDataException()).Open();return XDocument.Load(stream);}var strings=zip.GetEntry("xl/sharedStrings.xml") is null?[]:Xml("xl/sharedStrings.xml").Descendants(ns+"si").Select(e=>string.Concat(e.Descendants(ns+"t").Select(t=>t.Value))).ToList();var sheet=Xml("xl/workbook.xml").Descendants(ns+"sheet").First();var rid=sheet.Attribute(rel+"id")!.Value;var target=Xml("xl/_rels/workbook.xml.rels").Root!.Elements().Single(e=>e.Attribute("Id")?.Value==rid).Attribute("Target")!.Value;var path=target.StartsWith('/')?target.TrimStart('/'):"xl/"+target;var rows=new List<JsonArray>();List<string>? header=null;var truncated=false;var dateStyles=DateStyles(zip,Xml,ns);var epoch1904=Xml("xl/workbook.xml").Root?.Element(ns+"workbookPr")?.Attribute("date1904")?.Value is "1" or "true";
            var worksheet = Xml(path);
            var dimension = worksheet.Root?.Element(ns + "dimension")?.Attribute("ref")?.Value;
            var endCell = dimension?.Split(':').Last();
            var declaredWidth = endCell is null ? 0 : Math.Min(MaxCols, ColumnIndex(Regex.Match(endCell, "^[A-Za-z]+").Value) + 1);
            var firstRow = true;
            foreach(var row in worksheet.Descendants(ns+"row"))
            {
                if(header is not null&&rows.Count>=MaxRows){truncated=true;break;}
                if (firstRow)
                {
                    firstRow = false;
                    // read_only openpyxl iter_rows begins at worksheet row one, even when it has no cells.
                    if (int.TryParse(row.Attribute("r")?.Value, out var rowIndex) && rowIndex > 1)
                        header = Enumerable.Repeat("", declaredWidth).ToList();
                }
                var vals=new JsonArray();foreach(var c in row.Elements(ns+"c")){var index=ColumnIndex(ColumnName(c));if(index>=MaxCols)continue;while(vals.Count<=index)vals.Add("");var type=c.Attribute("t")?.Value;var value=c.Element(ns+"v")?.Value??"";vals[index]=type=="s"?strings[int.Parse(value,CultureInfo.InvariantCulture)].Trim():type=="inlineStr"?string.Concat(c.Descendants(ns+"t").Select(x=>x.Value)).Trim():type=="b"?JsonValue.Create(value=="1"):type is null or "n"&&double.TryParse(value,NumberStyles.Float,CultureInfo.InvariantCulture,out var num)?JsonValue.Create(num):JsonValue.Create(value.Trim());if((type is null or "n")&&c.Attribute("s") is {} style&&dateStyles.ContainsKey(int.Parse(style.Value))&&double.TryParse(value,NumberStyles.Float,CultureInfo.InvariantCulture,out var serial)){vals[index]=ExcelTemporal(serial,epoch1904,dateStyles[int.Parse(style.Value)]);}}if(header is null){while(vals.Count<declaredWidth)vals.Add("");header=vals.Select(Str).ToList();continue;}if(vals.Any(v=>Str(v).Length>0))rows.Add(vals);
            }Table(up,header??Enumerable.Repeat("",declaredWidth).ToList(),rows,truncated);
        }
        catch(AppException){throw;}catch{throw Bad("This Excel file could not be read. Save it again as .xlsx (no password).");}
    }
    private static void Parse(AssistantUploadModel up,string filename,byte[] bytes)
    {
        if(bytes.Length>MaxBytes)throw Bad("The file is larger than 5 MB. Export fewer rows or split it.");var name=filename.ToLowerInvariant();if(!Extensions.Any(name.EndsWith))throw Bad("Upload a CSV, Excel (.xlsx), text or JSON file.");if(name.EndsWith(".xlsx")){Excel(up,bytes);return;}string text;try{text=new UTF8Encoding(false,true).GetString(bytes);if(text.StartsWith('\uFEFF'))text=text[1..];}catch(DecoderFallbackException){text=Encoding.Latin1.GetString(bytes);}
        if(name.EndsWith(".csv")||name.EndsWith(".tsv"))
        {
            var sample=Cut(text,5000);var delimiter=name.EndsWith(".tsv")||sample.Count(c=>c=='\t')>sample.Count(c=>c==',')?'\t':',';using var records=CsvRows(text,delimiter).GetEnumerator();var header=records.MoveNext()?records.Current.Take(MaxCols).ToList():[];var rows=new List<JsonArray>();var truncated=false;while(records.MoveNext()){if(rows.Count>=MaxRows){truncated=true;break;}var values=records.Current.Take(MaxCols).Select(v=>v.Trim()).ToList();if(values.Any(v=>v.Length>0))rows.Add(new JsonArray(values.Select(v=>(JsonNode)JsonValue.Create(v)!).ToArray()));}Table(up,header,rows,truncated);return;
        }
        if(name.EndsWith(".json"))
        {
            JsonNode? parsed;try{parsed=JsonNode.Parse(text);}catch(JsonException){throw Bad("This JSON file is not valid.");}if(parsed is JsonArray array&&array.Count>0&&array.Take(50).All(x=>x is JsonObject)){var keys=array.Take(500).OfType<JsonObject>().SelectMany(x=>x.Select(k=>k.Key)).Distinct().Take(MaxCols).ToList();var rows=array.Take(MaxRows).Select(x=>new JsonArray(keys.Select(k=>Cell(x![k])).ToArray())).ToList();Table(up,keys,rows,array.Count>MaxRows);return;}up.Text=Cut(PythonJson(parsed,1,false),TextLimit);up.Truncated=text.Length>TextLimit;return;
        }up.Text=Cut(text,TextLimit);up.Truncated=text.Length>TextLimit;
    }
    internal static decimal? Number(JsonNode? node)
    {if(node is JsonValue b&&b.TryGetValue<bool>(out _))return null;var value=Regex.Replace(Str(node),@"[₹,\s]|^rs\.?|inr","",RegexOptions.IgnoreCase).Trim();if(value.StartsWith('(')&&value.EndsWith(')'))value="-"+value[1..^1];return Regex.IsMatch(value,@"^-?\d+(\.\d+)?$")&&decimal.TryParse(value,NumberStyles.AllowLeadingSign|NumberStyles.AllowDecimalPoint,CultureInfo.InvariantCulture,out var number)?number:null;}
    internal static JsonObject Profile(AssistantUploadModel up)
    {
        var columns=JsonNode.Parse(up.Columns) as JsonArray??[];if(columns.Count==0)return new(){["id"]=up.Id.ToString(),["filename"]=up.Filename,["kind"]="text",["characters"]=up.Text.Length,["truncated"]=up.Truncated,["preview"]=Cut(up.Text,3000)};var rows=(JsonNode.Parse(up.Rows) as JsonArray??[]).OfType<JsonArray>().ToList();var details=new JsonArray();for(var i=0;i<columns.Count;i++){var values=rows.Where(r=>i<r.Count&&Str(r[i]).Length>0).Select(r=>r[i]).ToList();var nums=values.Select(Number).Where(n=>n.HasValue).Select(n=>n!.Value).ToList();var kind=values.Count>0&&nums.Count>=.9*values.Count?"number":values.Count>0&&values.Take(50).All(v=>Regex.IsMatch(Str(v),@"^\d{4}-\d{2}-\d{2}|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}"))?"date":"text";var info=new JsonObject{["name"]=Str(columns[i]),["type"]=kind,["filled"]=values.Count,["empty"]=up.RowCount-values.Count,["distinct"]=values.Select(Str).Distinct().Count()};if(kind=="number"&&nums.Count>0){var sum=nums.Sum();info["sum"]=sum.ToString(CultureInfo.InvariantCulture);info["min"]=nums.Min().ToString(CultureInfo.InvariantCulture);info["max"]=nums.Max().ToString(CultureInfo.InvariantCulture);info["average"]=Math.Round(sum/nums.Count,2,MidpointRounding.ToEven).ToString("F2",CultureInfo.InvariantCulture);}else info["examples"]=new JsonArray(values.Select(Str).GroupBy(x=>x).OrderByDescending(g=>g.Count()).Take(3).Select(g=>(JsonNode)JsonValue.Create(Cut(g.Key,40))!).ToArray());details.Add(info);}return new(){["id"]=up.Id.ToString(),["filename"]=up.Filename,["kind"]="table",["rows"]=up.RowCount,["truncated"]=up.Truncated,["columns"]=details,["first_rows"]=new JsonArray(rows.Take(5).Select(r=>(JsonNode)new JsonObject(columns.Select((c,i)=>KeyValuePair.Create<string,JsonNode?>(Str(c),i<r.Count?r[i]?.DeepClone():null)))).ToArray())};
    }
    public async Task<JsonObject> StoreAsync(UserModel user,string filename,string contentType,byte[] bytes)
    {
        await access.RequireAsync(user,"assistant_files");await limits.RateLimitAsync($"assistant-upload:{user.Id}",60,3600);var now=DateTime.UtcNow;var up=new AssistantUploadModel{Id=Guid.NewGuid(),UserId=user.Id,Columns="[]",Rows="[]",Filename=Cut(Regex.Replace(filename,@"[^\w.\- ()]+","_"),200),ContentType=Cut(contentType,100),Size=bytes.Length,Sha256=Convert.ToHexStringLower(SHA256.HashData(bytes)),CreatedAt=now,ExpiresAt=now.AddDays(7)};Parse(up,filename,bytes);await using var tx=await db.BeginAsync();await data.InsertAsync(up,tx);await audit.InsertAsync(new(){Id=Guid.NewGuid(),ActorUserId=user.Id,Action="assistant.upload",EntityType="upload",EntityId=up.Id.ToString(),Detail=$"{up.Filename} {up.RowCount} rows",CreatedAt=now},tx.Transaction);await tx.CommitAsync();return Profile(up);
    }
    public async Task<JsonObject> DeleteAsync(UserModel user,Guid id){await access.RequireAsync(user,"assistant_files");await data.DeleteAsync(user.Id,id);return new(){["ok"]=true};}
}
