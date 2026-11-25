namespace Model.DomainModel;

/// <summary>delivery_zones: a named delivery area (reference: models/delivery.py DeliveryZone).</summary>
public class DeliveryZoneModel
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string City { get; set; } = "";
    /// <summary>JSON array of PIN codes.</summary>
    public string Pincodes { get; set; } = "[]";
    public bool IsActive { get; set; } = true;
    public decimal? CenterLat { get; set; }
    public decimal? CenterLng { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
