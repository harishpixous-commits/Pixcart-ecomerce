using System.Data;
using Model.DomainModel;
namespace DAL;
public partial class SellerAccountDAL
{
    public Task UpdateSubmissionAsync(SellerModel s, IDbTransaction tx) => db.ExecuteAsync(
        "UPDATE sellers SET status=@Status, submitted_at=@SubmittedAt, rejection_reason=@RejectionReason, updated_at=@UpdatedAt WHERE id=@Id", s, tx);
    public Task UpsertDocumentAsync(SellerDocumentModel d) => db.ExecuteAsync(
        "INSERT INTO seller_documents (id,seller_id,kind,storage_key,filename,content_type,size_bytes,uploaded_at) VALUES (@Id,@SellerId,@Kind,@StorageKey,@Filename,@ContentType,@SizeBytes,@UploadedAt) ON DUPLICATE KEY UPDATE storage_key=@StorageKey,filename=@Filename,content_type=@ContentType,size_bytes=@SizeBytes,uploaded_at=@UploadedAt", d);
}
