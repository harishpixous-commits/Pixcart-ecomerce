using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
namespace BAL;
public class AdminDashboardBAL(AdminDashboardDAL data,IAccessBAL access):IAdminDashboardBAL
{
    public async Task<JsonObject> ReadAsync(UserModel user)
    {
        await access.RequireAsync(user,"dashboard");var now=DateTime.UtcNow;var since=now.AddDays(-30);var today=now.AddMinutes(330).Date.AddMinutes(-330);var result=new JsonObject();
        var queries=new Dictionary<string,string>{
            ["sellers_pending_review"]="SELECT COUNT(*) FROM sellers WHERE status='submitted'",
            ["products_pending_review"]="SELECT COUNT(*) FROM products WHERE status='pending'",
            ["orders_today"]="SELECT COUNT(*) FROM orders WHERE status='placed' AND placed_at>=@today",
            ["gmv_30d"]="SELECT COALESCE(SUM(grand_total-refunded_total),0) FROM orders WHERE status='placed' AND placed_at>=@since",
            ["orders_30d"]="SELECT COUNT(*) FROM orders WHERE status='placed' AND placed_at>=@since",
            ["commission_30d"]="SELECT COALESCE(SUM(commission_paise),0) FROM sub_orders WHERE status NOT IN ('pending_payment','cancelled') AND created_at>=@since",
            ["refunds_needing_attention"]="SELECT COUNT(*) FROM refunds WHERE status='failed'",
            ["reviews_needing_attention"]="SELECT COUNT(*) FROM reviews WHERE status='pending' OR report_count>0 OR (media_status='pending' AND JSON_LENGTH(media)>0)",
            ["product_reports_open"]="SELECT COUNT(*) FROM product_reports WHERE status='open'",
            ["deals_pending"]="SELECT COUNT(*) FROM deals WHERE status='pending'",
            ["ads_pending"]="SELECT COUNT(*) FROM ad_campaigns WHERE status='pending'",
            ["questions_pending"]="SELECT (SELECT COUNT(*) FROM product_questions WHERE status='pending')+(SELECT COUNT(*) FROM product_answers WHERE status='pending')",
            ["delivery_kyc_pending"]="SELECT COUNT(*) FROM delivery_boys WHERE kyc_status='submitted'",
            ["delivery_waiting"]="SELECT COUNT(*) FROM sub_orders s WHERE shipping_provider='fleet' AND status='packed' AND ready_for_pickup_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM delivery_assignments a WHERE a.sub_order_id=s.id AND a.status IN ('offered','accepted','at_store','picked','on_the_way','reached'))",
            ["delivery_complaints_open"]="SELECT COUNT(*) FROM delivery_complaints WHERE status='open'",
            ["active_sellers"]="SELECT COUNT(*) FROM sellers WHERE status='approved'",
            ["customers"]="SELECT COUNT(*) FROM users",
            ["live_products"]="SELECT COUNT(*) FROM products WHERE status='approved'"};
        foreach(var(k,sql)in queries)result[k]=await data.ScalarAsync(sql,since,today);return result;
    }
}
