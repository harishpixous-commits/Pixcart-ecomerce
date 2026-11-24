using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.Constants;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class NotificationAdminBAL(NotificationAdminDAL data,IAccessBAL access,IIntegrationBAL integrations,IAuditBAL audit,IMySqlDapperHelper db):INotificationAdminBAL
{
    public async Task<JsonObject> TemplatesAsync(UserModel u)
    {
        await access.RequireAsync(u,"marketing");var saved=(await data.TemplatesAsync()).ToDictionary(x=>(x.Event,x.Channel));var items=new JsonArray();foreach(var(evt,chans)in NotificationEvents.Events)foreach(var channel in new[]{"inapp","email","sms","whatsapp"})
        {saved.TryGetValue((evt,channel),out var t);var has=chans.TryGetValue(channel,out var def);if(t is null&&!has&&channel!="whatsapp")continue;items.Add(new JsonObject{["event"]=evt,["channel"]=channel,["customised"]=t is not null,["subject"]=t?.Subject??(has?def.Subject:""),["body"]=t?.Body??(has?def.Body:""),["provider_template"]=t?.ProviderTemplate??"",["is_active"]=t?.IsActive??has});}
        var stats=new JsonObject();foreach(var s in await data.StatsAsync())stats[s.Status]=s.N;var cfg=await integrations.GetAsync();return new(){["items"]=items,["delivery"]=stats,["channels"]=new JsonObject{["email"]=cfg.SmtpHost.Length>0,["sms"]=cfg.SmsProvider=="msg91"&&cfg.Msg91AuthKey.Length>0,["whatsapp"]=cfg.WhatsappToken.Length>0}};
    }
    public async Task<JsonObject> SaveAsync(UserModel u,string evt,string channel,string subject,string body,string provider,bool active)
    {await access.RequireAsync(u,"marketing");if(!NotificationEvents.Events.ContainsKey(evt))throw new NotFoundException("Event");await using var tx=await db.BeginAsync();await data.SaveAsync(evt,channel,subject,body,provider.Trim(),active,tx);await audit.AuditAsync(u,"template.save","template",evt+":"+channel,"",tx);await tx.CommitAsync();return new(){["ok"]=true};}
    public async Task<JsonArray> CouponsAsync(UserModel u){await access.RequireAsync(u,"marketing");return new JsonArray((await data.CouponsAsync()).Select(x=>(JsonNode)CouponAdminBAL.AdminOut(x)).ToArray());}
}
