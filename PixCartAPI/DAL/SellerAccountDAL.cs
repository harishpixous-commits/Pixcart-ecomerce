using System.Data;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Seller accounts opened and corrected by staff (Admin → Sellers), and their default warehouse.</summary>
public partial class SellerAccountDAL(IMySqlDapperHelper db)
{
    public Task<SellerModel?> GetForUpdateAsync(Guid id, IDbTransaction tx) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @id FOR UPDATE", new { id }, tx);

    public Task<SellerModel?> GetAsync(Guid id, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @id", new { id }, tx);

    public async Task<bool> SlugTakenAsync(string slug, IDbTransaction? tx = null) =>
        await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM sellers WHERE slug = @slug", new { slug }, tx) > 0;

    public async Task<bool> GstinTakenAsync(string gstin, Guid except, IDbTransaction? tx = null) =>
        await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM sellers WHERE gstin = @gstin AND id <> @except", new { gstin, except }, tx) > 0;

    public Task InsertAsync(SellerModel s, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO sellers (user_id, status, display_name, slug, description, legal_name, business_type, gstin, pan_enc, pan_last4, contact_email, " +
            "contact_phone, pickup_line1, pickup_line2, pickup_city, pickup_state_code, pickup_pincode, bank_holder_name, bank_account_enc, bank_account_last4, " +
            "bank_ifsc, grievance_name, grievance_email, grievance_phone, commission_bps_override, rejection_reason, submitted_at, approved_at, " +
            "razorpay_account_id, dispatch_days, dispatch_cutoff, holiday_mode, invoice_prefix, payout_contact_id, payout_fund_account_id, rating_avg, " +
            "rating_count, id, created_at, updated_at) VALUES (@UserId, @Status, @DisplayName, @Slug, @Description, @LegalName, @BusinessType, @Gstin, " +
            "@PanEnc, @PanLast4, @ContactEmail, @ContactPhone, @PickupLine1, @PickupLine2, @PickupCity, @PickupStateCode, @PickupPincode, @BankHolderName, " +
            "@BankAccountEnc, @BankAccountLast4, @BankIfsc, @GrievanceName, @GrievanceEmail, @GrievancePhone, @CommissionBpsOverride, @RejectionReason, " +
            "@SubmittedAt, @ApprovedAt, @RazorpayAccountId, @DispatchDays, @DispatchCutoff, @HolidayMode, @InvoicePrefix, @PayoutContactId, " +
            "@PayoutFundAccountId, @RatingAvg, @RatingCount, @Id, @CreatedAt, @UpdatedAt)", s, tx);

    /// <summary>Writes the KYC and contact fields staff can correct.</summary>
    public Task UpdateKycAsync(SellerModel s, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "UPDATE sellers SET display_name = @DisplayName, description = @Description, legal_name = @LegalName, business_type = @BusinessType, " +
            "gstin = @Gstin, pan_enc = @PanEnc, pan_last4 = @PanLast4, contact_email = @ContactEmail, contact_phone = @ContactPhone, " +
            "pickup_line1 = @PickupLine1, pickup_line2 = @PickupLine2, pickup_city = @PickupCity, pickup_state_code = @PickupStateCode, " +
            "pickup_pincode = @PickupPincode, bank_holder_name = @BankHolderName, bank_account_enc = @BankAccountEnc, bank_account_last4 = @BankAccountLast4, " +
            "bank_ifsc = @BankIfsc, payout_fund_account_id = @PayoutFundAccountId, grievance_name = @GrievanceName, grievance_email = @GrievanceEmail, " +
            "grievance_phone = @GrievancePhone, updated_at = @UpdatedAt WHERE id = @Id", s, tx);

    public Task<IEnumerable<SellerDocumentModel>> DocumentsAsync(Guid sellerId, IDbTransaction? tx = null) =>
        db.QueryAsync<SellerDocumentModel>("SELECT * FROM seller_documents WHERE seller_id = @sellerId", new { sellerId }, tx);

    public Task<WarehouseModel?> DefaultWarehouseAsync(Guid sellerId, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<WarehouseModel>("SELECT * FROM warehouses WHERE seller_id = @sellerId AND is_default = 1", new { sellerId }, tx);

    public Task InsertWarehouseAsync(WarehouseModel w, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO warehouses (seller_id, code, name, line1, line2, city, state_code, pincode, contact_name, contact_phone, gstin, is_default, is_active, " +
            "shiprocket_pickup_name, lat, lng, id, created_at, updated_at) VALUES (@SellerId, @Code, @Name, @Line1, @Line2, @City, @StateCode, @Pincode, " +
            "@ContactName, @ContactPhone, @Gstin, @IsDefault, @IsActive, @ShiprocketPickupName, @Lat, @Lng, @Id, @CreatedAt, @UpdatedAt)", w, tx);

    public Task UpdateWarehouseAddressAsync(WarehouseModel w, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "UPDATE warehouses SET line1 = @Line1, line2 = @Line2, city = @City, state_code = @StateCode, pincode = @Pincode, updated_at = @UpdatedAt WHERE id = @Id", w, tx);
}
