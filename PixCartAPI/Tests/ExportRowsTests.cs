using DAL;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace Tests;
public class ExportRowsTests(ApiFactory f):ApiTest(f)
{
    private ExportsDAL Dal()=>new(new AppSettings{ConnectionString=ApiFactory.ConnectionString});
    private static ExportDefinitions.Spec Spec(string name,string scope="admin")=>ExportDefinitions.All.Single(s=>s.Name==name&&s.Scope==scope);
    private async Task<List<IReadOnlyList<object?>>> Read(string name,ExportDefinitions.Context context,string scope="admin")
    {var rows=new List<IReadOnlyList<object?>>();await foreach(var row in Dal().RowsAsync(Spec(name,scope),context))rows.Add(row);return rows;}
    [Fact]
    public async Task Every_non_TCS_plan_executes_against_schema_with_exact_header_width()
    {
        await Admin();
        foreach(var spec in ExportDefinitions.All.Where(s=>!s.NeedsMonth))
        {
            var context=ExportDefinitions.Parse(spec,sellerId:spec.Scope=="seller"?Guid.NewGuid():null,from:new(2026,1,1),to:new(2026,1,2));
            await foreach(var row in Dal().RowsAsync(spec,context))Assert.Equal(spec.Headers.Count,row.Count);
        }
    }
    private async Task<(Api User,Guid Seller,Guid Category,Guid Product,Guid Variant)> Seller(string phone,string sku)
    {
        var user=await LoginPhone(phone,"Synthetic Export Seller");var seller=Guid.Parse((await user.Post("/api/seller/register",new{display_name="Synthetic "+sku})).Json["id"]!.GetValue<string>());
        var category=Guid.NewGuid();await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@category,'Synthetic Export',@slug,'',1000,500,0,1,'[]')",new{category,slug="synthetic-"+sku.ToLowerInvariant()});
        var response=await user.Post("/api/seller/products",new{category_id=category,title="Synthetic 100%_ Cotton",brand="SyntheticBrand",hsn_code="6205",gst_bps=500,variants=new[]{new{sku,price_paise=12345,mrp_paise=20000,stock=7}}});Assert.Equal(201,response.Status);
        var product=Guid.Parse(response.Json["id"]!.GetValue<string>());var variant=Guid.Parse(response.Json["variants"]![0]!["id"]!.GetValue<string>());
        await ApiFactory.DbExecAsync("UPDATE variants SET options='{\"Size\":\"XL\"}' WHERE id=@variant",new{variant});return(user,seller,category,product,variant);
    }
    [Fact]
    public async Task Catalogue_and_stock_scope_filters_literal_wildcards_and_types()
    {
        await Admin();var a=await Seller("9876100081","EXPORT-A");var b=await Seller("9876100082","EXPORT-B");
        var all=await Read("products",ExportDefinitions.Parse(Spec("products")));Assert.Equal(2,all.Count);
        var own=await Read("products",ExportDefinitions.Parse(Spec("products","seller"),sellerId:a.Seller),"seller");Assert.Single(own);Assert.Equal("EXPORT-A",own[0][0]);Assert.Equal("Size: XL",own[0][2]);Assert.Equal("123.45",own[0][8]);Assert.Equal("5",own[0][11]);
        var filters=new Dictionary<string,string?>{["q"]="100%_",["category"]=a.Category.ToString(),["low_stock"]="7"};Assert.Single(await Read("products",ExportDefinitions.Parse(Spec("products"),extra:filters)));
        filters["low_stock"]="6";Assert.Empty(await Read("products",ExportDefinitions.Parse(Spec("products"),extra:filters)));
        filters["q"]="%' OR 1=1 --";filters.Remove("low_stock");Assert.Empty(await Read("products",ExportDefinitions.Parse(Spec("products"),extra:filters)));
        await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved' WHERE id=@id",new{id=a.Seller});
        var warehouse=await a.User.Post("/api/seller/warehouses",new{code="EX1",name="Synthetic Export Warehouse",line1="1 Synthetic Road",city="Coimbatore",state_code="33",pincode="641001"});Assert.Equal(201,warehouse.Status);
        var wid=warehouse.Json.AsArray()[0]!["id"]!.GetValue<string>();await ApiFactory.DbExecAsync("INSERT INTO inventory_levels(variant_id,warehouse_id,quantity,updated_at)VALUES(@variant,@wid,7,UTC_TIMESTAMP(6))",new{variant=a.Variant,wid});
        var stock=await Read("stock",ExportDefinitions.Parse(Spec("stock","seller"),sellerId:a.Seller),"seller");Assert.Single(stock);Assert.Equal("EXPORT-A",stock[0][0]);Assert.Equal(7,Convert.ToInt32(stock[0][2]));Assert.IsType<bool>(stock[0][7]);
        await ApiFactory.DbExecAsync("UPDATE products SET status='archived' WHERE id=@id",new{id=a.Product});Assert.Empty(await Read("stock",ExportDefinitions.Parse(Spec("stock","seller"),sellerId:a.Seller),"seller"));
    }
    [Fact]
    public async Task Packages_and_items_apply_IST_created_boundary_payment_owner_search_and_money()
    {
        await Admin();var a=await Seller("9876100083","EXPORT-C");var b=await Seller("9876100084","EXPORT-D");
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var orders=scope.ServiceProvider.GetRequiredService<OrdersDAL>();var start=new DateTime(2026,10,31,18,30,0);
        await using(var tx=await db.BeginAsync())
        {
            for(var i=0;i<5;i++)
            {
                var order=Guid.NewGuid();var sub=Guid.NewGuid();var created=i==1?start.AddSeconds(-1):i==2?start.AddDays(1):start;
                await orders.InsertOrderAsync(new(){Id=order,Number="SYNTH-EXPORT-O"+i,UserId=Guid.Parse(a.User.Id),Status="placed",PaymentMethod="cod",PaymentStatus="cod",ShipTo="{\"state_code\":\"33\"}",Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=created,UpdatedAt=created},tx);
                await orders.InsertSubOrderAsync(new(){Id=sub,OrderId=order,SellerId=i==3?b.Seller:a.Seller,Number="SYNTH-EXPORT-P"+i,Status=i==4?"pending_payment":"delivered",SettlementStatus="not_due",ItemsTotal=12345,Total=12345,CreatedAt=created,UpdatedAt=created},tx);
                await orders.InsertOrderItemAsync(new(){Id=Guid.NewGuid(),SubOrderId=sub,ProductId=a.Product,VariantId=a.Variant,Title="Synthetic item 100%_",Sku="EXPORT-C",Qty=2,UnitPrice=12345,UnitMrp=20000,LineTotal=24690,GstBps=500,TaxableValue=23000,Igst=1690},tx);
            }
            await tx.CommitAsync();
        }
        var context=ExportDefinitions.Parse(Spec("orders","seller"),sellerId:a.Seller,from:new(2026,11,1),to:new(2026,11,1),extra:new Dictionary<string,string?>{["payment_method"]="cod"});
        var packages=await Read("orders",context,"seller");Assert.Single(packages);Assert.Equal("SYNTH-EXPORT-P0",packages[0][0]);Assert.Equal("2026-11-01 00:00",packages[0][2]);Assert.Equal("Tamil Nadu",packages[0][8]);Assert.Equal("123.45",packages[0][14]);
        var items=await Read("order-items",context,"seller");Assert.Single(items);Assert.Equal("33-Tamil Nadu",items[0][7]);Assert.Equal("123.45",items[0][14]);Assert.Equal("5",items[0][19]);
        var filtered=ExportDefinitions.Parse(Spec("order-items","seller"),sellerId:a.Seller,from:new(2026,11,1),to:new(2026,11,1),extra:new Dictionary<string,string?>{["q"]="100%_"});Assert.Single(await Read("order-items",filtered,"seller"));
        using var cancel=new CancellationTokenSource();cancel.Cancel();await Assert.ThrowsAnyAsync<OperationCanceledException>(async()=>{await foreach(var _ in Dal().RowsAsync(Spec("orders"),context,cancel.Token)){};});
    }
    [Fact]
    public async Task Financial_register_customer_ticket_and_AI_rows_have_source_values()
    {
        var admin=await Admin();var a=await Seller("9876100085","EXPORT-E");var b=await Seller("9876100086","EXPORT-F");
        await ApiFactory.DbExecAsync("UPDATE sellers SET legal_name='Synthetic Legal',pickup_state_code='33',commission_bps_override=1050,holiday_mode=1 WHERE id=@id",new{id=a.Seller});
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var orders=scope.ServiceProvider.GetRequiredService<OrdersDAL>();var ledger=scope.ServiceProvider.GetRequiredService<LedgerDAL>();var returns=scope.ServiceProvider.GetRequiredService<ReturnsDAL>();var ai=scope.ServiceProvider.GetRequiredService<AiDAL>();
        var at=new DateTime(2026,11,1,1,0,0);var oid=Guid.NewGuid();var sub=Guid.NewGuid();var payout=Guid.NewGuid();var ret=Guid.NewGuid();var item=Guid.NewGuid();
        await using(var tx=await db.BeginAsync())
        {
            await orders.InsertOrderAsync(new(){Id=oid,Number="EXPORT-FIN-O",UserId=Guid.Parse(a.User.Id),Status="placed",PaymentMethod="cod",PaymentStatus="cod",ShipTo="{}",ItemsTotal=10000,GrandTotal=10000,RefundedTotal=123,Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=at,PlacedAt=at,UpdatedAt=at},tx);
            await orders.InsertSubOrderAsync(new(){Id=sub,OrderId=oid,SellerId=a.Seller,Number="EXPORT-FIN-P",Status="delivered",SettlementStatus="not_due",CreatedAt=at,UpdatedAt=at},tx);
            await orders.InsertOrderItemAsync(new(){Id=item,SubOrderId=sub,ProductId=a.Product,VariantId=a.Variant,Title="Synthetic",Qty=2,UnitPrice=5000,UnitMrp=6000,LineTotal=10000,TaxableValue=10000},tx);
            await ledger.InsertPayoutAsync(new(){Id=payout,SellerId=a.Seller,Number="EXPORT-PAYOUT",Amount=9876,Status="paid",Mode="bank",Utr="EXPORT-UTR",BankSnapshot="{\"account_last4\":\"0042\",\"ifsc\":\"SYNTH0001\"}",PaidAt=at,CreatedAt=at,UpdatedAt=at},tx);
            await returns.InsertReturnAsync(new(){Id=ret,SubOrderId=sub,SellerId=a.Seller,UserId=Guid.Parse(a.User.Id),Number="EXPORT-RETURN",Status="refunded",Reason="other",RefundAmount=123,CreatedAt=at,UpdatedAt=at,ReceivedAt=at,RefundedAt=at},tx);
            await returns.InsertReturnItemAsync(new(){Id=Guid.NewGuid(),ReturnId=ret,OrderItemId=item,Qty=1,Amount=123},tx);
            await tx.ExecuteAsync("INSERT INTO seller_ledger(id,seller_id,sub_order_id,payout_id,kind,amount,available_at,description,created_at)VALUES(UUID(),@seller,@sub,@payout,'adjustment',-123,@at,'Synthetic debit',@at)",new{seller=a.Seller,sub,payout,at});
            await tx.ExecuteAsync("INSERT INTO support_tickets(id,number,user_id,order_id,category,subject,status,priority,is_grievance,ack_due_at,resolve_due_at,acknowledged_at,resolved_at,created_at)VALUES(UUID(),'EXPORT-TICKET',@user,@oid,'other','Synthetic export ticket','resolved','normal',1,@at,@due,@at,@late,@at)",new{user=a.User.Id,oid,at,due=at.AddDays(30),late=at.AddDays(31)});
            await ai.InsertRunAsync(new(){Id=Guid.NewGuid(),Task="listing",SubjectType="product",SubjectId=a.Product.ToString(),SellerId=a.Seller,Inputs="{}",Output="{}",Status="applied",Mode="sandbox",Model="synthetic",InputTokens=10,OutputTokens=20,CreatedAt=at,CreatedBy=Guid.Parse(admin.Id)},tx);await tx.CommitAsync();
        }
        ExportDefinitions.Context C(string name)=>ExportDefinitions.Parse(Spec(name),from:new(2026,11,1),to:new(2026,11,1));
        var payouts=await Read("payouts",C("payouts"));Assert.Single(payouts);Assert.Equal("98.76",payouts[0][4]);Assert.Equal("0042",payouts[0][9]);Assert.Equal("SYNTH0001",payouts[0][10]);
        var entries=await Read("ledger",C("ledger"));Assert.Single(entries);Assert.Equal("-1.23",entries[0][5]);Assert.Equal("EXPORT-PAYOUT",entries[0][7]);
        var rets=await Read("returns",C("returns"));Assert.Single(rets);Assert.Equal(1,Convert.ToInt32(rets[0][6]));Assert.Equal("1.23",rets[0][7]);
        foreach(var name in new[]{"payouts","ledger","returns"})Assert.Empty(await Read(name,ExportDefinitions.Parse(Spec(name,"seller"),sellerId:b.Seller,from:new(2026,11,1),to:new(2026,11,1)),"seller"));
        var sellers=await Read("sellers",ExportDefinitions.Parse(Spec("sellers")));var seller=sellers.Single(r=>Equals(r[0],"Synthetic EXPORT-E"));Assert.Equal("Tamil Nadu",seller[6]);Assert.Equal("10.5",seller[10]);Assert.Equal(true,seller[14]);
        var customers=await Read("customers",ExportDefinitions.Parse(Spec("customers")));Assert.DoesNotContain(customers,r=>Equals(r[2],"admin@pixcart.in"));var customer=customers.Single(r=>Equals(r[1],"9876100085"));Assert.Equal(1,Convert.ToInt32(customer[4]));Assert.Equal("98.77",customer[5]);
        var tickets=await Read("tickets",C("tickets"));Assert.Single(tickets);Assert.Equal(true,tickets[0][10]);Assert.Equal(false,tickets[0][13]);
        var runs=await Read("ai-runs",C("ai-runs"));Assert.Single(runs);Assert.Equal(10,Convert.ToInt32(runs[0][6]));Assert.Equal("product:"+a.Product,runs[0][11]);
    }
    [Fact]
    public async Task Gift_card_and_referral_exports_mask_codes_and_show_money()
    {
        await Admin();var u1=await LoginPhone("9876100091","Synthetic Referrer");var u2=await LoginPhone("9876100092","Synthetic Friend");
        await ApiFactory.DbExecAsync("INSERT INTO gift_cards(id,code,initial_paise,balance_paise,expires_at,status,note,created_at)VALUES(UUID(),'GCSYNTH1234',50000,20000,'2030-01-01','active','Diwali',UTC_TIMESTAMP(6))");
        await ApiFactory.DbExecAsync("INSERT INTO referrals(id,referrer_id,referee_id,status,reward_paise,created_at,rewarded_at)VALUES(UUID(),@a,@b,'rewarded',2500,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",new{a=u1.Id,b=u2.Id});
        var cards=await Read("gift-cards",ExportDefinitions.Parse(Spec("gift-cards")));Assert.Single(cards);Assert.Equal("1234",cards[0][0]);Assert.Equal("500.00",cards[0][4]);Assert.Equal("200.00",cards[0][5]);Assert.Equal("300.00",cards[0][6]);Assert.Equal("Diwali",cards[0][7]);
        var voided=ExportDefinitions.Parse(Spec("gift-cards"),status:"void");Assert.Empty(await Read("gift-cards",voided));
        var refs=await Read("referrals",ExportDefinitions.Parse(Spec("referrals")));Assert.Single(refs);Assert.Equal("Synthetic Referrer",refs[0][0]);Assert.Equal("Synthetic Friend",refs[0][1]);Assert.Equal("rewarded",refs[0][3]);Assert.Equal("25.00",refs[0][4]);
    }
    [Fact]
    public async Task Loyalty_export_lists_entries_with_customer_and_type_filter()
    {
        await Admin();var u=await LoginPhone("9876100093","Synthetic Member");
        await ApiFactory.DbExecAsync("INSERT INTO loyalty_ledger(id,user_id,kind,points,note,created_at)VALUES(UUID(),@u,'earn',40,'Order',UTC_TIMESTAMP(6)),(UUID(),@u,'expire',-10,'Points expired',UTC_TIMESTAMP(6))",new{u=u.Id});
        var all=await Read("loyalty",ExportDefinitions.Parse(Spec("loyalty"),from:DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-1)),to:DateOnly.FromDateTime(DateTime.UtcNow.AddDays(1))));Assert.Equal(2,all.Count(r=>Equals(r[1],"Synthetic Member")));
        var expired=await Read("loyalty",ExportDefinitions.Parse(Spec("loyalty"),status:"expire",from:DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-1)),to:DateOnly.FromDateTime(DateTime.UtcNow.AddDays(1))));Assert.Single(expired);Assert.Equal(-10,Convert.ToInt32(expired[0][4]));
    }
}
