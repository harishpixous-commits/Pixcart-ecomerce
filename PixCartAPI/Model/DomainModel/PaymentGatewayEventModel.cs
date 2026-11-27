namespace Model.DomainModel;

/// <summary>One call to a payment gateway that created, checked, captured or refunded a payment (kept 7 days).</summary>
public class PaymentGatewayEventModel
{
    public Guid Id { get; set; }
    public string Gateway { get; set; } = "";
    public bool Ok { get; set; }
    public int Ms { get; set; }
    public string Error { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}
