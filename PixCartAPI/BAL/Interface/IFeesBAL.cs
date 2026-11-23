using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>Customer fees and the bill at checkout (Admin -> Checkout and fees); port of the reference services/fees.py.</summary>
public interface IFeesBAL
{
    /// <summary>The merged checkout settings (defaults plus saved values; unknown saved keys ignored).</summary>
    Task<JsonObject> GetAsync();
}
