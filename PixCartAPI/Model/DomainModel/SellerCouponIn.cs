using System.ComponentModel.DataAnnotations;
namespace Model.DomainModel;
public record SellerCouponIn
{
    [Required,StringLength(30,MinimumLength=4),RegularExpression("^[A-Za-z0-9]+$")]public string Code{get;init;}="";
    [StringLength(200)]public string Description{get;init;}="";
    [Required,RegularExpression("^(percent|flat)$")]public string Kind{get;init;}="";
    [Required,Range(1,int.MaxValue)]public int? Value{get;init;}
    [Range(1,long.MaxValue)]public long? MaxDiscountPaise{get;init;}
    [Range(0,long.MaxValue)]public long MinOrderPaise{get;init;}
    public DateTime? StartsAt{get;init;}
    public DateTime? EndsAt{get;init;}
    [Range(1,int.MaxValue)]public int? UsageLimit{get;init;}
    [Range(1,10)]public int PerUserLimit{get;init;}=1;
    public bool IsActive{get;init;}=true;
}
