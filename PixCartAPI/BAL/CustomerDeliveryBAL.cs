using System.Text.Json.Nodes;
using DAL;
using System.Text.RegularExpressions;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class CustomerDeliveryBAL(IMySqlDapperHelper db,CustomerDeliveryDAL data,IRateLimitBAL limits,INotifyBAL notify,IImageUpload images):ICustomerDeliveryBAL
{
    private static string Clean(string text)=>Regex.Replace(text.Trim(),@"\s+"," ");
    public async Task<JsonObject> RateAsync(UserModel user,Guid order,Guid sub,int rating,string comment)
    {
        await using var tx=await db.BeginAsync();await data.OwnAsync(user,order,tx);
        var(a,boy)=await data.RatingLockedAsync(order,sub,tx);
        var total=(double)boy.RatingAvg*boy.RatingCount-(a.Rating??0)+rating;var count=boy.RatingCount+(a.Rating is null?1:0);var avg=count>0?Math.Round(total/count,2,MidpointRounding.ToEven):0;
        await data.UpdateRatingAsync(a.Id,boy.Id,rating,Clean(comment),avg,count,tx);await tx.CommitAsync();return new JsonObject{["ok"]=true,["rating"]=rating};
    }
    public async Task<JsonObject> ComplainAsync(UserModel user,Guid order,Guid sub,string category,string text)
    {
        await using var tx=await db.BeginAsync();var o=await data.OwnAsync(user,order,tx);await limits.RateLimitAsync($"dcomplaint:{user.Id}",10,86400,tx);
        var a=await data.ComplaintTripAsync(order,sub,tx)??throw new AppException("There is no delivery to complain about yet","no_delivery");
        var id=Guid.NewGuid();await data.InsertComplaintAsync(id,a,user.Id,category,Clean(text),tx);
        await notify.NotifyStaffAsync("delivery","staff_message",new Dictionary<string,object?>{["subject"]="Delivery complaint on "+o.Number,["message"]=text.Length>0?text[..Math.Min(200,text.Length)]:category},"/admin/delivery/feedback",tx);await tx.CommitAsync();return new JsonObject{["ok"]=true,["id"]=id.ToString()};
    }
    public async Task<(byte[] Data,string Media)> ProofAsync(UserModel user,Guid order,Guid sub)
    {
        DeliveryAssignmentModel a;
        await using(var tx=await db.BeginAsync())
        {await data.OwnAsync(user,order,tx);a=await data.ProofTripAsync(order,sub,tx)??throw new NotFoundException("Delivery photo");}
        if(a.ProofPhoto.Length==0)throw new NotFoundException("Delivery photo");var bytes=await images.ReadPrivateAsync(a.ProofPhoto);return(bytes,a.ProofPhoto.Split('.').Last() switch{"png"=>"image/png","webp"=>"image/webp","pdf"=>"application/pdf",_=>"image/jpeg"});
    }
}
