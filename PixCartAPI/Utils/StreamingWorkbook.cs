using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
namespace Utils;

/// <summary>Forward-only XLSX export writer. Rows go straight to a ZIP entry, not a retained workbook graph.</summary>
public static class StreamingWorkbook
{
    private const string Ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    public static async Task<FileStream> BuildAsync(string sheetTitle, IReadOnlyList<string> columns,
        IAsyncEnumerable<IReadOnlyList<object?>> rows, string title, IReadOnlyList<(string Key, string Value)> about,
        CancellationToken cancellationToken = default)
    {
        var path = Path.Combine(Path.GetTempPath(), "pixcart-export-" + Guid.NewGuid().ToString("N") + ".xlsx");
        var file = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 256 * 1024, FileOptions.DeleteOnClose | FileOptions.SequentialScan);
        try
        {
            using (var zip = new ZipArchive(file, ZipArchiveMode.Create, leaveOpen:true))
            {
                void Part(string path, string text)
                {
                    using var output = new StreamWriter(zip.CreateEntry(path, CompressionLevel.Fastest).Open(), new UTF8Encoding(false)); output.Write(text);
                }
                Part("[Content_Types].xml", """
                    <?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>
                    """);
                Part("_rels/.rels", """
                    <?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>
                    """);
                var name = Regex.Replace(sheetTitle,@"[\[\]:*?/\\]"," "); name = name[..Math.Min(31,name.Length)]; if(name.Length==0)name="Sheet"; if(name.Equals("About",StringComparison.OrdinalIgnoreCase))name="About 2";
                using(var writer = Writer(zip,"xl/workbook.xml"))
                {
                    writer.WriteStartElement("workbook",Ns); writer.WriteAttributeString("xmlns","r",null,"http://schemas.openxmlformats.org/officeDocument/2006/relationships"); writer.WriteStartElement("sheets",Ns);
                    for(var i=1;i<=2;i++){writer.WriteStartElement("sheet",Ns);writer.WriteAttributeString("name",i==1?name:"About");writer.WriteAttributeString("sheetId",i.ToString());writer.WriteAttributeString("r","id","http://schemas.openxmlformats.org/officeDocument/2006/relationships","rId"+i);writer.WriteEndElement();}writer.WriteEndElement();writer.WriteEndElement();
                }
                Part("xl/_rels/workbook.xml.rels", """
                    <?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>
                    """);
                Part("xl/styles.xml", """
                    <?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="0.####"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF0"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>
                    """);
                var count=0;
                using(var writer=Writer(zip,"xl/worksheets/sheet1.xml"))
                {
                    writer.WriteStartElement("worksheet",Ns);writer.WriteStartElement("sheetViews",Ns);writer.WriteStartElement("sheetView",Ns);writer.WriteAttributeString("workbookViewId","0");writer.WriteStartElement("pane",Ns);writer.WriteAttributeString("ySplit","1");writer.WriteAttributeString("topLeftCell","A2");writer.WriteAttributeString("activePane","bottomLeft");writer.WriteAttributeString("state","frozen");writer.WriteEndElement();writer.WriteEndElement();writer.WriteEndElement();
                    writer.WriteStartElement("cols",Ns);for(var i=0;i<columns.Count;i++){writer.WriteStartElement("col",Ns);writer.WriteAttributeString("min",(i+1).ToString());writer.WriteAttributeString("max",(i+1).ToString());writer.WriteAttributeString("width",Math.Clamp(columns[i].Length+2,10,40).ToString(Inv));writer.WriteAttributeString("customWidth","1");writer.WriteEndElement();}writer.WriteEndElement();
                    writer.WriteStartElement("sheetData",Ns); Row(writer,1,columns.Cast<object?>().ToList(),true);
                    await foreach(var row in rows.WithCancellation(cancellationToken))
                    {
                        cancellationToken.ThrowIfCancellationRequested(); count++;
                        if(count>1_048_575)throw new InvalidOperationException("Excel row limit exceeded");
                        Row(writer,count+1,row,false);
                    }
                    writer.WriteEndElement();writer.WriteStartElement("autoFilter",Ns);writer.WriteAttributeString("ref","A1:"+Column(Math.Max(1,columns.Count))+(count+1));writer.WriteEndElement();writer.WriteEndElement();
                }
                using(var writer=Writer(zip,"xl/worksheets/sheet2.xml"))
                {
                    writer.WriteStartElement("worksheet",Ns);writer.WriteStartElement("sheetData",Ns);Row(writer,1,[title],false,true);var r=2;foreach(var (key,value) in about)Row(writer,r++,[key,value],false,true);Row(writer,r,["Rows",count.ToString("N0",Inv)],false,true);writer.WriteEndElement();writer.WriteEndElement();
                }
            }
            await file.FlushAsync(cancellationToken);file.Position=0;return file;
        }
        catch{await file.DisposeAsync();throw;}
    }
    private static XmlWriter Writer(ZipArchive zip,string name)=>XmlWriter.Create(zip.CreateEntry(name,CompressionLevel.Fastest).Open(),new XmlWriterSettings{Encoding=new UTF8Encoding(false),CloseOutput=true,CheckCharacters=true});
    private static string Column(int n){var s="";while(n>0){n--;s=(char)('A'+n%26)+s;n/=26;}return s;}
    private static void Row(XmlWriter w,int row,IReadOnlyList<object?> cells,bool header,bool forceText=false)
    {
        w.WriteStartElement("row",Ns);w.WriteAttributeString("r",row.ToString());
        for(var i=0;i<cells.Count;i++)
        {
            var raw=cells[i];var s=Regex.Replace(Convert.ToString(raw,Inv)??"",@"[\x00-\x08\x0b\x0c\x0e-\x1f]","");var style=0;string? number=null;
            if(!header&&!forceText)
            {
                if(raw is bool b)s=b?"yes":"no";
                else if(raw is int or long or short or byte){number=s;style=2;}
                else if(raw is float or double or decimal){number=s;style=3;}
                else
                {
                    if(s.Length>1&&s[0]=='\''&&"=+-@".Contains(s[1]))s=s[1..];
                    style=Regex.IsMatch(s,@"^-?\d{1,13}\.\d{2}$")?3:Regex.IsMatch(s,@"^-?(0|[1-9]\d{0,8})$")?4:Regex.IsMatch(s,@"^-?\d{1,9}\.\d{1,4}$")?5:0;
                    if(style>0&&double.TryParse(s,NumberStyles.Float,Inv,out var n))number=n.ToString("R",Inv);
                }
            }
            w.WriteStartElement("c",Ns);w.WriteAttributeString("r",Column(i+1)+row);w.WriteAttributeString("s",(header?1:style).ToString());
            if(number is not null)w.WriteElementString("v",Ns,number);
            else{w.WriteAttributeString("t","inlineStr");w.WriteStartElement("is",Ns);w.WriteStartElement("t",Ns);w.WriteAttributeString("xml","space","http://www.w3.org/XML/1998/namespace","preserve");w.WriteString(s);w.WriteEndElement();w.WriteEndElement();}w.WriteEndElement();
        }
        w.WriteEndElement();
    }
}
