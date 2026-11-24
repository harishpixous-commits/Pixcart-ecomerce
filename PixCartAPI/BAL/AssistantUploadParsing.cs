using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
namespace BAL;
public partial class AssistantUploadBAL
{
    private static IEnumerable<List<string>> CsvRows(string text,char delimiter)
    {
        var fields=new List<string>();var cell=new StringBuilder();var quoted=false;var started=false;for(var i=0;i<text.Length;i++)
        {
            var c=text[i];if(quoted){if(c=='"'){if(i+1<text.Length&&text[i+1]=='"'){cell.Append('"');i++;}else quoted=false;}else cell.Append(c);continue;}
            if(c=='"'&&cell.Length==0){quoted=true;started=true;continue;}if(c==delimiter){fields.Add(cell.ToString());cell.Clear();started=true;continue;}if(c is '\r' or '\n'){if(c=='\r'&&i+1<text.Length&&text[i+1]=='\n')i++;if(started||cell.Length>0||fields.Count>0)fields.Add(cell.ToString());yield return fields;fields=[];cell.Clear();started=false;continue;}cell.Append(c);started=true;
        }if(started||cell.Length>0||fields.Count>0){fields.Add(cell.ToString());yield return fields;}
    }
    private static string PythonJson(JsonNode? value,int? indent,bool ascii,int depth=0)
    {
        string Quote(string text){var encoded=JsonSerializer.Serialize(text,new JsonSerializerOptions{Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping});if(!ascii)return encoded;var b=new StringBuilder();foreach(var c in encoded)if(c>127)b.Append("\\u").Append(((int)c).ToString("x4"));else b.Append(c);return b.ToString();}
        if(value is JsonObject obj){if(obj.Count==0)return "{}";var entries=obj.Select(k=>Quote(k.Key)+": "+PythonJson(k.Value,indent,ascii,depth+1));return indent is {} n?"{\n"+string.Join(",\n",entries.Select(e=>new string(' ',(depth+1)*n)+e))+"\n"+new string(' ',depth*n)+"}":"{"+string.Join(", ",entries)+"}";}
        if(value is JsonArray a){if(a.Count==0)return "[]";var entries=a.Select(v=>PythonJson(v,indent,ascii,depth+1));return indent is {} n?"[\n"+string.Join(",\n",entries.Select(e=>new string(' ',(depth+1)*n)+e))+"\n"+new string(' ',depth*n)+"]":"["+string.Join(", ",entries)+"]";}
        if(value is JsonValue v&&v.TryGetValue<string>(out var s))return Quote(s);return value?.ToJsonString()??"null";
    }
    private static HashSet<int> DateStyles(ZipArchive zip,Func<string,XDocument> xml,XNamespace ns)
    {
        if(zip.GetEntry("xl/styles.xml") is null)return [];var root=xml("xl/styles.xml").Root!;var formats=root.Element(ns+"numFmts")?.Elements(ns+"numFmt").ToDictionary(x=>int.Parse(x.Attribute("numFmtId")!.Value),x=>x.Attribute("formatCode")!.Value)??[];var styles=root.Element(ns+"cellXfs")?.Elements(ns+"xf").ToList()??[];var dates=new HashSet<int>();for(var i=0;i<styles.Count;i++){var id=int.Parse(styles[i].Attribute("numFmtId")?.Value??"0");var code=formats.GetValueOrDefault(id,"");code=Regex.Replace(code,"\"[^\"]*\"|\\\\.|\\[[^\\]]*\\]","");if(id is >=14 and <=22 or >=45 and <=47||Regex.IsMatch(code,"[ymdhis]",RegexOptions.IgnoreCase))dates.Add(i);}return dates;
    }
}
