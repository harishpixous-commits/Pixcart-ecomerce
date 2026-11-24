using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.VisualBasic.FileIO;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public partial class SellerProductsBAL
{
    private static readonly string[] ImportColumns = ["product_key","title","category","brand","description","highlights","hsn_code","gst_rate","return_window_days","country_of_origin","sku","option_1_name","option_1_value","option_2_name","option_2_value","mrp","price","stock","weight_grams"];
    private sealed class ImportGroup(string key,int row,Dictionary<string,string> first)
    {
        public string Key=key; public int Row=row; public Dictionary<string,string> First=first;
        public JsonArray Variants=[]; public List<string> Errors=[]; public JsonObject? Payload; public string Category="";
        public JsonObject Preview()=>new(){["key"]=Key,["row"]=Row,["title"]=First.GetValueOrDefault("title",""),["category"]=Category,["variants"]=Variants.Count,["errors"]=new JsonArray(Errors.Select(e=>(JsonNode)JsonValue.Create(e)).ToArray())};
    }
    private static string CsvCell(string value)=>value.IndexOfAny([',','"','\r','\n'])>=0?"\""+value.Replace("\"","\"\"")+"\"":value;
    public string ImportTemplate()
    {
        string[][] rows=[ImportColumns,
            ["KURTA-01","Kovai Men's Cotton Straight Kurta, Sky Blue","Men's Clothing","Kovai","Breathable pure cotton kurta for daily wear. Machine wash cold.","100% cotton|Regular fit|Machine washable","6205","5","7","India","KURTA01-M","Size","M","","","1299","699","25","300"],
            ["KURTA-01","","","","","","","","","","KURTA01-L","Size","L","","","1299","699","30","320"]];
        return "\ufeff"+string.Join("",rows.Select(r=>string.Join(",",r.Select(CsvCell))+"\r\n"));
    }
    private static long ImportMoney(string raw,string field)
    {
        if(!decimal.TryParse(raw.Replace(",","").Replace("₹","").Trim(),NumberStyles.Float,CultureInfo.InvariantCulture,out var d))throw new FormatException(field+" must be a number in rupees");
        if(d<=0)throw new FormatException(field+" must be more than 0");
        try{return checked((long)decimal.Round(d*100,0,MidpointRounding.ToEven));}catch(OverflowException){throw new FormatException(field+" is too large");}
    }
    private static long ImportInt(string raw,string field,long? fallback=null)
    {
        raw=raw.Trim();if(raw.Length==0)return fallback??throw new FormatException(field+" is required");
        if(!Regex.IsMatch(raw,@"^\d+$")||!long.TryParse(raw,out var n))throw new FormatException(field+" must be a whole number");return n;
    }
    private async Task<(List<ImportGroup>,JsonArray)> ParseImportAsync(UserModel user,SellerModel seller,byte[] data,IUnitOfWork tx)
    {
        var groups=new Dictionary<string,ImportGroup>(StringComparer.Ordinal);var fileErrors=new JsonArray();
        void FileError(int row,string message)=>fileErrors.Add(new JsonObject{["row"]=row,["error"]=message});
        if(data.Length>2*1024*1024){FileError(0,"The file is larger than 2 MB. Split it into smaller files.");return ([],fileErrors);}
        string text;try{text=new UTF8Encoding(false,true).GetString(data).TrimStart('\ufeff');}catch(DecoderFallbackException){FileError(0,"Save the file as CSV UTF-8 and upload it again.");return ([],fileErrors);}
        using var parser=new TextFieldParser(new StringReader(text)){TextFieldType=FieldType.Delimited,HasFieldsEnclosedInQuotes=true,TrimWhiteSpace=false};parser.SetDelimiters(",");
        string[] headers;try{headers=parser.EndOfData?[]:parser.ReadFields()!.Select(h=>h.Trim().ToLowerInvariant()).ToArray();}catch(MalformedLineException){FileError(1,"Invalid CSV headers");return ([],fileErrors);}
        string[] required=["product_key","title","category","hsn_code","sku","mrp","price","stock"];
        var missing=required.Except(headers).Order(StringComparer.Ordinal).ToList();if(missing.Count>0){FileError(1,"Missing columns: "+string.Join(", ",missing)+". Download the template for the exact headers.");return ([],fileErrors);}
        var cats=(await catalog.ActiveCategoriesAsync()).ToList();var parents=cats.Where(c=>c.ParentId!=null).Select(c=>c.ParentId!.Value).ToHashSet();var byId=cats.ToDictionary(c=>c.Id);var leaves=new Dictionary<string,CategoryModel>(StringComparer.OrdinalIgnoreCase);
        foreach(var c in cats.Where(c=>!parents.Contains(c.Id)))
        {
            var path=new List<string>{c.Name};var current=c;var visited=new HashSet<Guid>{c.Id};
            while(current.ParentId is {} pid&&byId.TryGetValue(pid,out var parent)&&visited.Add(pid)){path.Insert(0,parent.Name);current=parent;}
            foreach(var key in new[]{c.Name,c.Slug,string.Join(" > ",path),string.Join(" › ",path)})leaves.TryAdd(key,c);
        }
        var rowNumber=1;
        while(!parser.EndOfData)
        {
            rowNumber++;if(rowNumber-1>2000){FileError(rowNumber,"Only the first 2000 rows are read; upload the rest in another file.");break;}
            string[] values;try{values=parser.ReadFields()!;}catch(MalformedLineException){FileError(rowNumber,"Invalid CSV row");continue;}
            var row=new Dictionary<string,string>();for(var i=0;i<headers.Length;i++)if(headers[i].Length>0)row[headers[i]]=i<values.Length?values[i].Trim():"";
            string Get(string k)=>row.GetValueOrDefault(k,"");if(row.Values.All(string.IsNullOrEmpty))continue;
            var key=Get("product_key");if(key.Length==0)key=Get("title");if(key.Length==0){FileError(rowNumber,"product_key is empty");continue;}
            if(!groups.TryGetValue(key,out var g)){g=new(key,rowNumber,row);groups.Add(key,g);}
            try
            {
                var options=new JsonObject();for(var i=1;i<=2;i++){var name=Get($"option_{i}_name");var value=Get($"option_{i}_value");if(name.Length+value.Length==0)continue;if(name.Length==0||value.Length==0)throw new FormatException($"option_{i}_name and option_{i}_value go together");options[name]=value;}
                g.Variants.Add(new JsonObject{["sku"]=Get("sku"),["options"]=options,["mrp_paise"]=ImportMoney(Get("mrp"),"mrp"),["price_paise"]=ImportMoney(Get("price"),"price"),["stock"]=ImportInt(Get("stock"),"stock"),["weight_grams"]=ImportInt(Get("weight_grams"),"weight_grams",500)});
            }catch(FormatException e){g.Errors.Add($"Row {rowNumber}: {e.Message}");}
        }
        if(groups.Count>300){FileError(0,"Upload at most 300 products per file.");return ([],fileErrors);}
        var seen=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach(var g in groups.Values)
        {
            string Get(string k)=>g.First.GetValueOrDefault(k,"");
            var cat=leaves.GetValueOrDefault(Get("category"));g.Category=cat?.Name??Get("category");
            if(cat is null)g.Errors.Add($"Row {g.Row}: category \"{Get("category")}\" not found. Use a sub-category name from the listing form.");
            foreach(var v in g.Variants.OfType<JsonObject>())
            {
                var sku=v["sku"]!.GetValue<string>();if(await dal.SkuTakenAsync(seller.Id,sku,null,tx))g.Errors.Add($"SKU {sku} already exists in your catalogue");
                else if(seen.TryGetValue(sku,out var previous)&&previous!=g.Key)g.Errors.Add($"SKU {sku} is also used by product {previous} in this file");seen[sku]=g.Key;
            }
            if(cat is null)continue;
            // Collect the independent top-level field errors before variant validation, as the reference schema does.
            if(Get("title").Length is <10 or >200)g.Errors.Add("Title must be 10 to 200 characters");
            if(!Regex.IsMatch(Get("hsn_code"),@"^\d{4}(\d{2}){0,2}$"))g.Errors.Add("HSN code must be 4, 6 or 8 digits");
            try
            {
                var gst=Get("gst_rate");var bps=gst.Length==0?cat.DefaultGstBps:checked((int)(decimal.Parse(gst,NumberStyles.Float,CultureInfo.InvariantCulture)*100));
                if(!new[]{0,25,300,500,1200,1800,2800,4000}.Contains(bps))g.Errors.Add("GST rate must be one of 0, 0.25, 3, 5, 12, 18, 28 or 40");
                var days=ImportInt(Get("return_window_days"),"return_window_days",cat.ReturnWindowDays);if(days>30)g.Errors.Add("Return window must be 0 to 30 days");
                g.Payload=new JsonObject{["category_id"]=cat.Id.ToString(),["title"]=Get("title"),["brand"]=Get("brand"),["description"]=Get("description"),["hsn_code"]=Get("hsn_code"),["gst_bps"]=bps,["return_window_days"]=days,["country_of_origin"]=Get("country_of_origin").Length==0?"India":Get("country_of_origin"),["highlights"]=new JsonArray(Get("highlights").Split('|').Where(h=>h.Trim().Length>0).Take(10).Select(h=>(JsonNode)JsonValue.Create(h)).ToArray()),["variants"]=g.Variants.DeepClone()};
                if(g.Errors.Count==0)await SaveCoreAsync(user,seller,null,g.Payload,tx,validateOnly:true,writeAudit:false);
                // Rows with no readable variants already carry their own error, rather than a second list-size error.
                else if(g.Variants.Count>0){try{ReadVariants(g.Payload);}catch(AppException e){g.Errors.Add(e.Message);}}
            }catch(Exception e)when(e is AppException or FormatException or OverflowException){g.Errors.Add(e.Message);}
            g.Errors=g.Errors.Distinct().ToList();if(g.Errors.Count>0)g.Payload=null;
        }
        return (groups.Values.ToList(),fileErrors);
    }
    public async Task<JsonObject> ImportAsync(UserModel user,SellerModel seller,byte[] data,string filename,bool dryRun)
    {
        if(seller.Status=="suspended")throw new ConflictException("Your seller account is suspended","seller_suspended");
        await using var tx=await db.BeginAsync();await rateLimit.RateLimitAsync($"product-import:{seller.Id}",30,3600,tx);
        var (products,fileErrors)=await ParseImportAsync(user,seller,data,tx);var created=new JsonArray();
        if(!dryRun)
        {
            foreach(var item in products.Where(p=>p.Payload is not null))
            {
                var id=await SaveCoreAsync(user,seller,null,item.Payload!,tx,writeAudit:false);
                created.Add(new JsonObject{["key"]=item.Key,["id"]=id.ToString(),["title"]=item.First.GetValueOrDefault("title","").Trim()});
            }
            var note=$"{created.Count} products from {filename}";await audit.AuditAsync(user,"product.import","seller",seller.Id,note[..Math.Min(200,note.Length)],tx);
        }
        await tx.CommitAsync();return new JsonObject{["dry_run"]=dryRun,["file_errors"]=fileErrors,["products"]=new JsonArray(products.Select(p=>(JsonNode)p.Preview()).ToArray()),["valid"]=products.Count(p=>p.Payload is not null),["invalid"]=products.Count(p=>p.Payload is null),["created"]=created};
    }
}
