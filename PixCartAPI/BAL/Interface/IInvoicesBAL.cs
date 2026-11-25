namespace BAL.Interface;

/// <summary>Customer-facing GST documents as PDF (reference: routers/customer.py invoice, fee_invoice,
/// credit_note + services/invoices.py, services/fee_invoices.py).</summary>
public interface IInvoicesBAL
{
    Task<(byte[] Pdf,string Filename)> AdminFeeInvoicePdfAsync(Model.DomainModel.UserModel admin,Guid orderId);
    Task<(byte[] Pdf,string Filename)> SellerInvoicePdfAsync(Guid sellerId,Guid subId);
    Task<(byte[] Pdf,string Filename)> SellerCreditNotePdfAsync(Guid sellerId,Guid returnId);
    /// <summary>The seller's tax invoice for a sub-order the customer owns; issued when the package ships.</summary>
    Task<(byte[] Pdf, string Filename)> InvoicePdfAsync(Guid userId, Guid subId);

    /// <summary>The marketplace's own tax invoice for the fees on an order; issued when the first package is delivered.</summary>
    Task<(byte[] Pdf, string Filename)> FeeInvoicePdfAsync(Guid userId, Guid orderId);

    /// <summary>The seller's credit note for a refunded return.</summary>
    Task<(byte[] Pdf, string Filename)> CreditNotePdfAsync(Guid userId, Guid returnId);
}
