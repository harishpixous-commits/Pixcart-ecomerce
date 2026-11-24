using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
namespace Utils;
public static class ExportCsv
{
    public static IReadOnlyList<object?> Pick(IReadOnlyList<object?> row,IReadOnlyList<int> columns) => row.Count==1&&columns.Count>1?row:columns.Select(i=>i<row.Count?row[i]:"").ToList();
    public static byte[] Encode(IEnumerable<IReadOnlyList<object?>> rows)
    {
        var text=new StringBuilder();
        foreach(var row in rows)
        {
            var fields=row.Select(value=>
            {
                string s;
                if(value is null)s="";
                else if(value is bool b)s=b?"yes":"no";
                else
                {
                    s=Convert.ToString(value,CultureInfo.InvariantCulture)??"";
                    if(value is not (int or long or short or byte or float or double or decimal))
                    {
                        s=s.Replace("\r\n"," ").Replace("\r"," ");
                        if(s.Length>0&&"=+-@\t".Contains(s[0])&&!Regex.IsMatch(s,@"^-?\d+(\.\d+)?$"))s="'"+s;
                    }
                }
                return s.IndexOfAny([',','"','\r','\n'])>=0?"\""+s.Replace("\"","\"\"")+"\"":s;
            });
            text.Append(string.Join(",",fields)).Append("\r\n");
        }
        return Encoding.UTF8.GetBytes(text.ToString());
    }
}
