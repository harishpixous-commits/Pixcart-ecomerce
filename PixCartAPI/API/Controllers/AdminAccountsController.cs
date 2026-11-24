using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel.Auth;

namespace API.Controllers;

/// <summary>Admin → Staff and roles (/api/admin/permissions, roles, staff): the reference routers/staff.py.</summary>
[ApiController]
[Perm("staff")]
public class StaffController(IStaffBAL staff, ICurrentUser me) : ControllerBase
{
    [HttpGet("/api/admin/permissions")]
    public object Permissions() => staff.PermissionCatalog();

    [HttpGet("/api/admin/roles")]
    public Task<object> Roles() => staff.ListRolesAsync();

    [HttpPost("/api/admin/roles")]
    public async Task<IActionResult> CreateRole([FromBody] RoleIn body) => StatusCode(201, await staff.CreateRoleAsync(await me.RequireAsync(), body));

    [HttpPut("/api/admin/roles/{code}")]
    public async Task<object> UpdateRole(string code, [FromBody] RoleIn body) => await staff.UpdateRoleAsync(await me.RequireAsync(), code, body);

    [HttpDelete("/api/admin/roles/{code}")]
    public async Task<object> DeleteRole(string code)
    {
        await staff.DeleteRoleAsync(await me.RequireAsync(), code);
        return new { ok = true };
    }

    [HttpGet("/api/admin/staff")]
    public async Task<object> ListStaff() => await staff.ListStaffAsync(await me.RequireAsync());

    [HttpPost("/api/admin/staff")]
    public async Task<IActionResult> AddStaff([FromBody] StaffIn body) => StatusCode(201, await staff.AddStaffAsync(await me.RequireAsync(), body));

    [HttpPatch("/api/admin/staff/{userId:guid}")]
    public async Task<object> EditStaff(Guid userId, [FromBody] StaffPatchIn body)
    {
        await staff.EditStaffAsync(await me.RequireAsync(), userId, body);
        return new { ok = true };
    }
}

/// <summary>
/// Admin → Customers, sellers created or corrected by staff, and Admin → Sign-in and accounts: the reference
/// routers/admin_accounts.py.
/// </summary>
[ApiController]
public class AdminAccountsController(IAccountAdminBAL admin, ICurrentUser me) : ControllerBase
{
    [HttpGet("/api/admin/auth-settings"), Perm("settings")]
    public Task<Dictionary<string, object?>> GetAuthSettings() => admin.GetAuthSettingsAsync();

    [HttpPut("/api/admin/auth-settings"), Perm("settings")]
    public async Task<object> PutAuthSettings([FromBody] JsonObject body) => await admin.PutAuthSettingsAsync(await me.RequireAsync(), body);

    [HttpPost("/api/admin/customers"), Perm("customers")]
    public async Task<IActionResult> CreateCustomer([FromBody] CustomerIn body) => StatusCode(201, await admin.CreateCustomerAsync(await me.RequireAsync(), body));

    [HttpGet("/api/admin/customers/{userId:guid}"), Perm("customers")]
    public Task<Dictionary<string, object?>> CustomerDetail(Guid userId) => admin.CustomerDetailAsync(userId);

    [HttpPatch("/api/admin/customers/{userId:guid}"), Perm("customers")]
    public async Task<object> EditCustomer(Guid userId, [FromBody] CustomerPatchIn body) => await admin.EditCustomerAsync(await me.RequireAsync(), userId, body);

    [HttpPost("/api/admin/customers/{userId:guid}/sign-out"), Perm("customers")]
    public async Task<object> SignOutCustomer(Guid userId) => await admin.SignOutCustomerAsync(await me.RequireAsync(), userId);

    [HttpPost("/api/admin/sellers"), Perm("sellers")]
    public async Task<IActionResult> CreateSeller([FromBody] SellerCreateIn body) => StatusCode(201, await admin.CreateSellerAsync(await me.RequireAsync(), body));

    [HttpPut("/api/admin/sellers/{sellerId:guid}/business"), Perm("sellers")]
    public async Task<object> SellerBusiness(Guid sellerId, [FromBody] SellerProfileIn body) => await admin.SellerBusinessAsync(await me.RequireAsync(), sellerId, body);

    [HttpPut("/api/admin/sellers/{sellerId:guid}/pickup-address"), Perm("sellers")]
    public async Task<object> SellerPickup(Guid sellerId, [FromBody] SellerPickupIn body) => await admin.SellerPickupAsync(await me.RequireAsync(), sellerId, body);

    [HttpPut("/api/admin/sellers/{sellerId:guid}/bank"), Perm("sellers")]
    public async Task<object> SellerBank(Guid sellerId, [FromBody] SellerBankIn body) => await admin.SellerBankAsync(await me.RequireAsync(), sellerId, body);

    [HttpPut("/api/admin/sellers/{sellerId:guid}/grievance-officer"), Perm("sellers")]
    public async Task<object> SellerGrievance(Guid sellerId, [FromBody] SellerGrievanceIn body) =>
        await admin.SellerGrievanceAsync(await me.RequireAsync(), sellerId, body);

    // ---------------------------------------------------------------- the staff member's own admin preferences

    [HttpGet("/api/admin/me/preferences"), AdminOnly]
    public async Task<object> ReadPreferences([FromServices] IAdminPrefsBAL prefs) => await prefs.ReadAsync(await me.RequireAsync());

    [HttpPut("/api/admin/me/preferences"), AdminOnly]
    public async Task<object> WritePreferences([FromServices] IAdminPrefsBAL prefs, [FromBody] JsonObject body) => await prefs.WriteAsync(await me.RequireAsync(), body);
}

/// <summary>Admin → Integrations (/api/admin/integrations): the reference routers/integrations.py.</summary>
[ApiController]
[Perm("integrations")]
public class IntegrationsController(IIntegrationBAL integrations, ICurrentUser me) : ControllerBase
{
    [HttpGet("/api/admin/integrations")]
    public Task<object> List() => integrations.ListAsync();

    [HttpPut("/api/admin/integrations/{key}")]
    public async Task<object> Save(string key, [FromBody] IntegrationSaveIn body) =>
        await integrations.SaveFromAdminAsync(await me.RequireAsync(), key, body.Values, body.Clear, body.Enabled, body.Password!, body.Totp);

    [HttpPost("/api/admin/integrations/{key}/test")]
    public async Task<object> Test(string key, [FromBody] IntegrationTestIn body) =>
        await integrations.TestFromAdminAsync(await me.RequireAsync(), key, body.Phone, body.To);
}

/// <summary>Inbound webhooks (/api/webhooks): the reference routers/webhooks.py.</summary>
[ApiController]
public class WebhooksController(IWebhookBAL webhooks) : ControllerBase
{
    private async Task<byte[]> BodyAsync()
    {
        using var ms = new MemoryStream();
        await Request.Body.CopyToAsync(ms);
        return ms.ToArray();
    }

    [HttpPost("/api/webhooks/razorpayx")]
    public async Task<object> Razorpayx() =>
        await webhooks.RazorpayxAsync(await BodyAsync(), Request.Headers["x-razorpay-signature"].ToString(), Request.Headers["x-razorpay-event-id"].ToString());

    [HttpPost("/api/webhooks/shiprocket")]
    public async Task<object> Shiprocket() => await webhooks.ShiprocketAsync(await BodyAsync(), Request.Headers["x-api-key"].ToString());
}
