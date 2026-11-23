using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>delivery_boys + delivery_zones reads/writes (reference: the fleet service's partner queries).</summary>
public class DeliveryDAL(IMySqlDapperHelper db)
{
    public Task<DeliveryBoyModel?> PartnerForUserAsync(Guid userId) =>
        db.QueryFirstOrDefaultAsync<DeliveryBoyModel>("SELECT * FROM delivery_boys WHERE user_id = @userId", new { userId });

    public Task<DeliveryZoneModel?> ZoneAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<DeliveryZoneModel>("SELECT * FROM delivery_zones WHERE id = @id", new { id });

    public async Task<IReadOnlyList<DeliveryZoneModel>> ActiveZonesAsync()
    {
        var rows = await db.QueryAsync<DeliveryZoneModel>(
            "SELECT * FROM delivery_zones WHERE is_active = 1 ORDER BY city, name");
        return rows.ToList();
    }

    public Task<int> InsertPartnerAsync(DeliveryBoyModel b) =>
        db.ExecuteAsync(
            """
            INSERT INTO delivery_boys
                (id, user_id, name, phone, photo, city, address, license_no, license_doc, id_proof_type,
                 id_proof_last4, id_proof_enc, id_proof_doc, vehicle_type, vehicle_no, vehicle_doc, zone_id,
                 is_online, is_active, kyc_status, kyc_note, approved_at, lat, lng, location_at, online_since,
                 bank_details, rating_avg, rating_count, created_at, updated_at)
            VALUES
                (@Id, @UserId, @Name, @Phone, @Photo, @City, @Address, @LicenseNo, @LicenseDoc, @IdProofType,
                 @IdProofLast4, @IdProofEnc, @IdProofDoc, @VehicleType, @VehicleNo, @VehicleDoc, @ZoneId,
                 @IsOnline, @IsActive, @KycStatus, @KycNote, @ApprovedAt, @Lat, @Lng, @LocationAt, @OnlineSince,
                 @BankDetails, @RatingAvg, @RatingCount, @CreatedAt, @UpdatedAt)
            """, b);

    public Task<int> UpdatePartnerAsync(DeliveryBoyModel b) =>
        db.ExecuteAsync(
            """
            UPDATE delivery_boys SET name = @Name, phone = @Phone, photo = @Photo, city = @City, address = @Address,
                license_no = @LicenseNo, license_doc = @LicenseDoc, id_proof_type = @IdProofType,
                id_proof_last4 = @IdProofLast4, id_proof_enc = @IdProofEnc, id_proof_doc = @IdProofDoc,
                vehicle_type = @VehicleType, vehicle_no = @VehicleNo, vehicle_doc = @VehicleDoc, zone_id = @ZoneId,
                is_online = @IsOnline, is_active = @IsActive, kyc_status = @KycStatus, kyc_note = @KycNote,
                approved_at = @ApprovedAt, lat = @Lat, lng = @Lng, location_at = @LocationAt,
                online_since = @OnlineSince, bank_details = @BankDetails, updated_at = UTC_TIMESTAMP(6)
            WHERE id = @Id
            """, b);
}
