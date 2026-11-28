using System.ComponentModel.DataAnnotations;
namespace Model.DomainModel;
public record SellerCouponIn
{
    [Required,StringLength(30,MinimumLength=4),RegularExpression("^[A-Za-z0-9]+$")]public string Code{get;init;}="";
    [StringLength(200)]public string Description{get;init;}="";
    [Required,RegularExpression("^(percent|flat)$")]public string Kind{get;init;}="";
    [Required,Range(1,100_000_000)]public int? Value{get;init;}
    [Range(1,10_000_000_000)]public long? MaxDiscountPaise{get;init;}
    [Range(0,10_000_000_000)]public long MinOrderPaise{get;init;}
    public DateTime? StartsAt{get;init;}
    public DateTime? EndsAt{get;init;}
    [Range(1,1_000_000_000)]public int? UsageLimit{get;init;}
    [Range(1,10)]public int PerUserLimit{get;init;}=1;
    public bool IsActive{get;init;}=true;
}
