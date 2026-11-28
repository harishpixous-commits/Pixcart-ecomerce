using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using Utils;
namespace BAL;
public partial class FeesBAL
{
    public static JsonObject ValidateUpdates(JsonObject input,JsonObject current)
    {
        var data=(JsonObject)input.DeepClone();var clean=new JsonObject();
        if(data.ContainsKey("surge_hours")){if(!SettingsJson.IsWholeNumber(data["surge_hours"],out var hours)||hours is <0 or >SurgeHoursMax)throw new AppException($"Charge the bad weather fee for 1 to {SurgeHoursMax} hours, or until you switch it off","invalid_setting");clean["surge_until"]=SurgeHoursUntil((int)hours);data.Remove("surge_hours");data.Remove("surge_until");}
        foreach(var(k,node)in data)
        {
            if(!Defaults().ContainsKey(k))throw new AppException("Unknown setting: "+k,"invalid_setting");var v=node?.DeepClone();
            if(k=="surge_until")
            {var t=node is JsonValue j&&j.TryGetValue<string>(out var st)?st:null;if(t is null||t.Length>0&&(!System.Text.RegularExpressions.Regex.IsMatch(t,@"(Z|[+-]\d{2}:?\d{2})$",System.Text.RegularExpressions.RegexOptions.IgnoreCase)||!DateTimeOffset.TryParse(t,CultureInfo.InvariantCulture,DateTimeStyles.None,out _)))throw new AppException("surge_until must be a date and time with a time zone, or empty","invalid_setting");v=t.Length==0?"":DateTimeOffset.Parse(t,CultureInfo.InvariantCulture).ToUniversalTime().ToString("o");}
            else if(Times.Contains(k)){if(node is not JsonValue tv||!tv.TryGetValue<string>(out var time)||!ValidTime(time))throw new AppException("Late night times use the 24-hour clock, like 23:00","invalid_setting");}
            else if(Codes.TryGetValue(k,out var code)){var text=SettingsJson.Text(node).Trim().ToUpperInvariant();if(!code.Re.IsMatch(text))throw new AppException(code.Message,"invalid_setting");v=text;}
            else if(Ints.TryGetValue(k,out var range)){if(!SettingsJson.IsWholeNumber(node,out var n)||n<range.Lo||n>range.Hi)throw new AppException($"{k} must be a whole number between {range.Lo} and {range.Hi}","invalid_setting");}
            else if(k=="delivery_slots"){var joined=string.Join("; ",SlotList(node is JsonValue sv&&sv.TryGetValue<string>(out var sraw)?sraw:""));if(SlotList(joined).Count is <2 or >6)throw new AppException("Give 2 to 6 delivery time choices, split with ;","invalid_setting");v=joined;}
            else if(Texts.TryGetValue(k,out var max)){if(node is not JsonValue textv||!textv.TryGetValue<string>(out var text)||text.Length>max)throw new AppException($"{k} must be text up to {max} characters","invalid_setting");text=k.EndsWith("_label")?PlatformSettingsBAL.Tidy(text):text.Trim();if(k.EndsWith("_label")&&text.Length<2)throw new AppException("Fee names need at least 2 characters","invalid_setting");v=text;}
            else if(k=="tip_presets"){if(node is not JsonArray arr||arr.Count is <1 or >4||arr.Any(x=>!SettingsJson.IsWholeNumber(x,out var n)||n is <100 or >100000))throw new AppException("Tip amounts: 1 to 4 amounts between ₹1 and ₹1,000","invalid_setting");v=new JsonArray(arr.Select(x=>SettingsJson.ToLong(x)).Distinct().Order().Select(x=>(JsonNode)JsonValue.Create(x)!).ToArray());}
            else if(node?.GetValueKind() is not(JsonValueKind.True or JsonValueKind.False))throw new AppException(k+" must be on or off","invalid_setting");
            clean[k]=v;
        }
        if(clean.ContainsKey("surge_enabled")&&clean.Bool("surge_enabled")!=current.Bool("surge_enabled")&&!clean.ContainsKey("surge_until"))clean["surge_until"]="";
        var merged=(JsonObject)current.DeepClone();foreach(var(k,v)in clean)merged[k]=v?.DeepClone();if(merged.Long("handling_list_paise")!=0&&merged.Long("handling_list_paise")<=merged.Long("handling_paise"))throw new AppException("The regular handling fee shown struck through must be higher than the fee charged","invalid_setting");if(merged.Str("late_night_from")==merged.Str("late_night_to"))throw new AppException("The late night fee needs a start time different from its end time","invalid_setting");return clean;
    }
}
