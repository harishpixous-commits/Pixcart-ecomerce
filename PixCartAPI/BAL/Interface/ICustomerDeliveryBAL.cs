using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface ICustomerDeliveryBAL
{
    Task<JsonObject> RateAsync(UserModel user,Guid order,Guid sub,int rating,string comment);
    Task<JsonObject> ComplainAsync(UserModel user,Guid order,Guid sub,string category,string text);
    Task<(byte[] Data,string Media)> ProofAsync(UserModel user,Guid order,Guid sub);
}
