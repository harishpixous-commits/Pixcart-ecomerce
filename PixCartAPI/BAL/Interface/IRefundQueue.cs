namespace BAL.Interface;

/// <summary>Reliable after-response work (reference: FastAPI BackgroundTasks). Endpoints enqueue; a hosted worker
/// sends the refunds after the response. A crash before the send is covered by the refund retry job.</summary>
public interface IRefundQueue
{
    void Enqueue(IEnumerable<Guid> refundIds);
}
