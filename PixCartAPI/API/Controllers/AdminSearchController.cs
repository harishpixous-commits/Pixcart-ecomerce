using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin")]
public class AdminSearchController(IAdminSearchBAL search,IAccessBAL access,ICurrentUser me):ControllerBase
{
    [HttpGet("search")]public async Task<object> Search([FromQuery,StringLength(80)]string q="")=>await search.SearchAsync(await me.RequireAsync(),q);
    [HttpGet("me")]public async Task<object> Me()
    {var user=await me.RequireAsync();if(!user.IsAdmin)throw new ForbiddenException("Admin access required");var perms=await access.PermissionsForAsync(user);if(!perms.Contains("dashboard"))throw new ForbiddenException("Your role does not allow this (dashboard)");var code=access.RoleCode(user);return new{role=code,role_label=await access.RoleNameAsync(code),permissions=perms.OrderBy(x=>x).ToArray(),totp_enabled=user.TotpEnabled,name=user.Name,is_owner=code=="owner",two_step_required=await access.TwoStepMissingAsync(user)};}
}
