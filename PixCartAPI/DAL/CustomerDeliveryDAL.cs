using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace DAL;
public class CustomerDeliveryDAL
{
    public async Task<OrderModel> OwnAsync(UserModel user,Guid id,IUnitOfWork tx)
    {var o=await tx.QueryFirstOrDefaultAsync<OrderModel>("SELECT * FROM orders WHERE id=@id",new{id});return o is not null&&o.UserId==user.Id?o:throw new NotFoundException("Order");}
    public async Task<(DeliveryAssignmentModel a,DeliveryBoyModel boy)> RatingLockedAsync(Guid order,Guid sub,IUnitOfWork tx)
    {
        if(!await tx.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM sub_orders WHERE id=@sub AND order_id=@order)",new{sub,order}))throw new NotFoundException("Order part");
        var a=await tx.QueryFirstOrDefaultAsync<DeliveryAssignmentModel>("SELECT * FROM delivery_assignments WHERE sub_order_id=@sub AND kind='delivery' AND status='delivered' LIMIT 1 FOR UPDATE",new{sub})??throw new AppException("You can rate the delivery once it is delivered","not_delivered");
        var boy=(await tx.QueryFirstOrDefaultAsync<DeliveryBoyModel>("SELECT * FROM delivery_boys WHERE id=@id FOR UPDATE",new{id=a.DeliveryBoyId}))!;
        return(a,boy);
    }

    public async Task UpdateRatingAsync(Guid id,Guid boy,int rating,string comment,double avg,int count,IUnitOfWork tx)
    {
        await tx.ExecuteAsync("UPDATE delivery_assignments SET rating=@rating,rating_comment=@comment,rated_at=UTC_TIMESTAMP(6) WHERE id=@id",new{rating,comment,id});
        await tx.ExecuteAsync("UPDATE delivery_boys SET rating_avg=@avg,rating_count=@count,updated_at=UTC_TIMESTAMP(6) WHERE id=@boy",new{avg,count,boy});
    }
    public Task<DeliveryAssignmentModel?> ComplaintTripAsync(Guid order,Guid sub,IUnitOfWork tx)=>tx.QueryFirstOrDefaultAsync<DeliveryAssignmentModel>("SELECT * FROM delivery_assignments WHERE sub_order_id=@sub AND order_id=@order AND kind='delivery' AND status IN ('delivered','failed') ORDER BY created_at DESC LIMIT 1",new{sub,order});
    public Task<int> InsertComplaintAsync(Guid id,DeliveryAssignmentModel a,Guid user,string category,string text,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO delivery_complaints(id,assignment_id,delivery_boy_id,user_id,category,text,status,admin_note,created_at)VALUES(@id,@aid,@bid,@user,@category,@text,'open','',UTC_TIMESTAMP(6))",new{id,aid=a.Id,bid=a.DeliveryBoyId,user,category,text});
    public Task<DeliveryAssignmentModel?> ProofTripAsync(Guid order,Guid sub,IUnitOfWork tx)=>tx.QueryFirstOrDefaultAsync<DeliveryAssignmentModel>("SELECT * FROM delivery_assignments WHERE sub_order_id=@sub AND order_id=@order AND status='delivered' AND kind='delivery' LIMIT 1",new{sub,order});
}
