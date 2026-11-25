namespace Model.DomainModel;

/// <summary>delivery_boys: a delivery partner going through KYC (reference: models/delivery.py DeliveryBoy).</summary>
public class DeliveryBoyModel
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    public string Phone { get; set; } = "";
    public string Photo { get; set; } = "";
    public string City { get; set; } = "";
    public string Address { get; set; } = "";
    public string LicenseNo { get; set; } = "";
    public string LicenseDoc { get; set; } = "";
    public string IdProofType { get; set; } = "";
    public string IdProofLast4 { get; set; } = "";
    public string IdProofEnc { get; set; } = "";
    public string IdProofDoc { get; set; } = "";
    public string VehicleType { get; set; } = "bike";
    public string VehicleNo { get; set; } = "";
    public string VehicleDoc { get; set; } = "";
    public Guid? ZoneId { get; set; }
    public bool IsOnline { get; set; }
    public bool IsActive { get; set; } = true;
    public string KycStatus { get; set; } = "draft";
    public string KycNote { get; set; } = "";
    public DateTime? ApprovedAt { get; set; }
    public decimal? Lat { get; set; }
    public decimal? Lng { get; set; }
    public DateTime? LocationAt { get; set; }
    public DateTime? OnlineSince { get; set; }
    /// <summary>JSON: holder, ifsc, account_last4, account_enc, upi.</summary>
    public string BankDetails { get; set; } = "{}";
    public decimal RatingAvg { get; set; }
    public int RatingCount { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
