namespace Tests;
public class DeliveryRouteParityTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Reference_return_assign_route_binds_url_and_keeps_permission_gates()
    {
        var id=Guid.NewGuid();var partner=Guid.NewGuid();var admin=await Admin();var r=await admin.Post($"/api/admin/delivery/returns/{id}/assign",new{partner_id=partner,direct=true,force=true});Assert.True(r.Status==409,r.ToString());Assert.Equal("not_waiting",r.ErrorCode);
        var staff=await Staff(admin,"catalogroute@example.test","catalog");r=await staff.Post($"/api/admin/delivery/returns/{id}/assign",new{partner_id=partner});Assert.True(r.Status==403,r.ToString());Assert.Equal("Your role does not allow this (delivery)",r.ErrorMessage);
        var user=await LoginPhone("9896000001");r=await user.Post($"/api/admin/delivery/returns/{id}/assign",new{partner_id=partner});Assert.Equal(403,r.Status);Assert.Equal("Admin access required",r.ErrorMessage);
        Assert.Equal(422,(await admin.Post($"/api/admin/delivery/returns/{id}/assign",new{})).Status);
        // Existing port-specific alias remains available and reaches the same not-waiting domain branch.
        Assert.Equal(409,(await admin.Post("/api/admin/delivery/returns/assign",new{return_id=id,partner_id=partner})).Status);
    }
}
