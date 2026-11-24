using BAL;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Xunit;

namespace PixCartAPI.Tests;

/// <summary>
/// Regression for the staff-permission gap found in the delivery-fleet admin mutations: every staff fleet
/// mutation must check the "delivery" permission BEFORE touching any other dependency. Each method is invoked
/// with a throwing access stub and null for everything else; a regression that moved the check later would
/// surface as a NullReferenceException instead of the expected ForbiddenException. Mirrors the runtime matrix
/// (18 probes: 9 routes x staff-without-delivery and non-staff, all 403).
/// </summary>
public sealed class FleetStaffPermissionTests
{
    private sealed class ThrowingAccess(string message) : IAccessBAL
    {
        public readonly List<string> Asked = new();

        public Task<HashSet<string>> PermissionsForAsync(UserModel user) => throw new NotImplementedException();
        public Task RequireAsync(UserModel user, string permission)
        {
            Asked.Add(permission);
            throw new ForbiddenException(message);
        }
        public Task<bool> TwoStepMissingAsync(UserModel user) => Task.FromResult(false);
        public string RoleCode(UserModel user) => "";
        public Task<string> RoleNameAsync(string code) => Task.FromResult("");
        public void Invalidate() { }
    }

    private static DeliveryFleetBAL Fleet(IAccessBAL access) => new(
        null!, null!, null!, null!, null!, null!, null!, null!, access,
        null!, null!, null!, null!, null!, null!, null!, null!, null!, null!);

    private static readonly UserModel Staff = new() { Id = Guid.NewGuid(), Name = "Staff", IsAdmin = true, AdminRole = "catalog" };

    public static IEnumerable<object[]> Mutations()
    {
        yield return Wrap(f => f.AssignByStaffAsync(Staff, Guid.NewGuid(), Guid.NewGuid(), false, false));
        yield return Wrap(f => f.AutoAssignByStaffAsync(Staff, Guid.NewGuid()));
        yield return Wrap(f => f.CancelByStaffAsync(Staff, Guid.NewGuid(), "test reason"));
        yield return Wrap(f => f.ResolveFailedAsync(Staff, Guid.NewGuid(), "retry"));
        yield return Wrap(f => f.ToCourierByStaffAsync(Staff, Guid.NewGuid()));
        yield return Wrap(f => f.AssignPickupByStaffAsync(Staff, Guid.NewGuid(), Guid.NewGuid(), false, false));
        yield return Wrap(f => f.AutoAssignPickupByStaffAsync(Staff, Guid.NewGuid()));
        yield return Wrap(f => f.PickupToCourierByStaffAsync(Staff, Guid.NewGuid()));
        yield return Wrap(f => f.ReturnCandidatesAsync(Staff, Guid.NewGuid()));
    }

    private static object[] Wrap(Func<DeliveryFleetBAL, Task> call) => [call];

    [Theory]
    [MemberData(nameof(Mutations))]
    public async Task Staff_mutation_checks_delivery_permission_first(Func<DeliveryFleetBAL, Task> call)
    {
        var access = new ThrowingAccess("Your role does not allow this (delivery)");
        var ex = await Assert.ThrowsAsync<ForbiddenException>(() => call(Fleet(access)));
        Assert.Equal("Your role does not allow this (delivery)", ex.Message);
        Assert.Equal(["delivery"], access.Asked);
    }

    [Fact]
    public async Task Non_staff_user_is_refused_before_any_lookup()
    {
        // AccessBAL itself: a non-admin user is rejected without touching the roles store (null DALs stand).
        var access = new AccessBAL(null!, null!, new AppSettings());
        var user = new UserModel { Id = Guid.NewGuid(), Name = "Shopper", IsAdmin = false };
        var ex = await Assert.ThrowsAsync<ForbiddenException>(() => access.RequireAsync(user, "delivery"));
        Assert.Equal("Admin access required", ex.Message);
    }
}
