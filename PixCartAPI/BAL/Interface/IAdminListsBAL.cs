using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminListsBAL
{
    Task<JsonObject> CustomersAsync(UserModel user,string q,int page,int size,string kind);
    Task<JsonObject> AuditAsync(UserModel user,string? entity,int page);
    Task<JsonObject> TicketsAsync(UserModel user,string? status,bool overdue,bool grievance,int page,string q);
}
