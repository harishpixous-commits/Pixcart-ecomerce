using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public partial class DeliveryFleetDAL
{
    public Task<EarningTotals?> EarningsPeriodAsync(Guid boy,DateTime? since,DateTime? until=null)=>db.QueryFirstOrDefaultAsync<EarningTotals>("SELECT COUNT(*) AS Trips,COALESCE(SUM(fee_paise),0) AS Fees,COALESCE(SUM(tip_paise),0) AS Tips,COALESCE(SUM(bonus_paise),0) AS Bonuses,COALESCE(SUM(cod_collected),0) AS CodCollected FROM delivery_assignments WHERE delivery_boy_id=@boy AND status='delivered' AND (@since IS NULL OR delivered_at>=@since) AND (@until IS NULL OR delivered_at<@until)",new{boy,since,until});
    public Task<long> UnpaidEarningsAsync(Guid boy)=>db.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(fee_paise+tip_paise+bonus_paise),0) FROM delivery_assignments WHERE delivery_boy_id=@boy AND status='delivered' AND payout_id IS NULL",new{boy});
    public Task<IEnumerable<DeliveryPayoutModel>> PartnerPayoutsAsync(Guid boy)=>db.QueryAsync<DeliveryPayoutModel>("SELECT * FROM delivery_payouts WHERE delivery_boy_id=@boy ORDER BY period_start DESC LIMIT 12",new{boy});
    public Task<IEnumerable<DeliveryCashDepositModel>> PartnerDepositsAsync(Guid boy)=>db.QueryAsync<DeliveryCashDepositModel>("SELECT * FROM delivery_cash_deposits WHERE delivery_boy_id=@boy ORDER BY created_at DESC LIMIT 10",new{boy});
    private const string HistoryWhere=" WHERE a.delivery_boy_id=@boy AND a.status NOT IN ('offered','accepted','at_store','picked','on_the_way','reached') AND (@status='' OR a.status=@status) AND (@since IS NULL OR a.assigned_at>=@since) AND (@until IS NULL OR a.assigned_at<@until)";
    public Task<long> PartnerHistoryCountAsync(Guid boy,string status,DateTime? since,DateTime? until)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM delivery_assignments a"+HistoryWhere,new{boy,status,since,until});
    public Task<IEnumerable<PartnerHistoryRow>> PartnerHistoryAsync(Guid boy,string status,DateTime? since,DateTime? until,int offset)=>db.QueryAsync<PartnerHistoryRow>("SELECT a.*,s.number AS OrderNumber,o.ship_to AS ShipTo FROM delivery_assignments a LEFT JOIN sub_orders s ON s.id=a.sub_order_id LEFT JOIN orders o ON o.id=a.order_id"+HistoryWhere+" ORDER BY a.assigned_at DESC LIMIT 20 OFFSET @offset",new{boy,status,since,until,offset});
}
public class EarningTotals{public long Trips{get;set;}public long Fees{get;set;}public long Tips{get;set;}public long Bonuses{get;set;}public long CodCollected{get;set;}}
public class PartnerHistoryRow:DeliveryAssignmentModel{public string OrderNumber{get;set;}="";public string ShipTo{get;set;}="{}";}
