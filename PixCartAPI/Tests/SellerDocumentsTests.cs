using DAL;
using Microsoft.Extensions.DependencyInjection;
using System.Net.Http.Headers;
using Utils.Interface;
namespace Tests;
public class SellerDocumentsTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Seller_document_ownership_ready_guards_and_shared_pdf_renderer()
    {
        var u=await LoginPhone("9883000001","Synthetic Document Seller");var customer=await LoginPhone("9883000002","Synthetic Buyer");var sid=Guid.Parse((await u.Post("/api/seller/register",new{display_name="Synthetic Document Store"})).Json["id"]!.GetValue<string>());var oid=Guid.NewGuid();var sub=Guid.NewGuid();var ret=Guid.NewGuid();
        var cat=Guid.NewGuid();await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@cat,'Synthetic Documents','synthetic-documents','',1000,500,0,1,'[]')",new{cat});var product=(await u.Post("/api/seller/products",new{category_id=cat,title="Synthetic Invoice Cotton Shirt",hsn_code="6205",gst_bps=500,variants=new[]{new{sku="DOCUMENT-SKU",mrp_paise=20000,price_paise=10500,stock=10}}})).Json;var pid=Guid.Parse(product["id"]!.GetValue<string>());var vid=Guid.Parse(product["variants"]![0]!["id"]!.GetValue<string>());var item=Guid.NewGuid();
        await ApiFactory.DbExecAsync("UPDATE sellers SET legal_name='Synthetic Textiles',pickup_line1='12 Synthetic Road',pickup_city='Coimbatore',pickup_state_code='33',pickup_pincode='641001' WHERE id=@sid",new{sid});
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var dal=scope.ServiceProvider.GetRequiredService<OrdersDAL>();var returns=scope.ServiceProvider.GetRequiredService<ReturnsDAL>();
        await using(var tx=await db.BeginAsync())
        {
            await dal.InsertOrderAsync(new(){Id=oid,Number="SYNTH-DOC-ORDER",UserId=Guid.Parse(customer.Id),Status="placed",PaymentMethod="cod",PaymentStatus="cod",ShipTo="{\"full_name\":\"Synthetic Buyer\",\"city\":\"Coimbatore\",\"state_code\":\"33\",\"state\":\"Tamil Nadu\"}",Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=DateTime.UtcNow,UpdatedAt=DateTime.UtcNow},tx);
            await dal.InsertSubOrderAsync(new(){Id=sub,OrderId=oid,SellerId=sid,Number="SYNTH-DOC-PACKAGE",Total=10500,ItemsTotal=10500,Status="delivered",SettlementStatus="not_due",CreatedAt=DateTime.UtcNow,UpdatedAt=DateTime.UtcNow},tx);
            await dal.InsertOrderItemAsync(new(){Id=item,SubOrderId=sub,ProductId=pid,VariantId=vid,Title="Synthetic Invoice Cotton Shirt",Sku="DOCUMENT-SKU",HsnCode="6205",Qty=1,UnitPrice=10500,UnitMrp=20000,LineTotal=10500,GstBps=500,TaxableValue=10000,Cgst=250,Sgst=250},tx);
            await returns.InsertReturnAsync(new(){Id=ret,SubOrderId=sub,SellerId=sid,UserId=Guid.Parse(customer.Id),Number="SYNTH-RETURN",Status="refunded",Reason="other",CreatedAt=DateTime.UtcNow,UpdatedAt=DateTime.UtcNow},tx);await returns.InsertReturnItemAsync(new(){Id=Guid.NewGuid(),ReturnId=ret,OrderItemId=item,Qty=1,Amount=10500,Condition="sellable"},tx);await tx.CommitAsync();
        }
        Assert.Equal("manual",(await u.Get("/api/seller/shipping")).Json["provider"]!.GetValue<string>());Assert.Equal(404,(await u.Get($"/api/seller/orders/{sub}/invoice.pdf")).Status);Assert.Equal(404,(await u.Get($"/api/seller/returns/{ret}/credit-note.pdf")).Status);
        var other=await LoginPhone("9883000003");await other.Post("/api/seller/register",new{display_name="Synthetic Other Documents"});
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET invoice_number='SYNTH-INV-001',invoice_date=UTC_TIMESTAMP(6) WHERE id=@sub",new{sub});await ApiFactory.DbExecAsync("UPDATE return_requests SET credit_note_number='SYNTH-CN-001' WHERE id=@ret",new{ret});
        Assert.Equal(404,(await other.Get($"/api/seller/orders/{sub}/invoice.pdf")).Status);Assert.Equal(404,(await other.Get($"/api/seller/returns/{ret}/credit-note.pdf")).Status);Assert.Equal(404,(await u.Get($"/api/invoices/{sub}.pdf")).Status);
        using var client=Factory.CreateClient();async Task<byte[]> Pdf(string url,string path,bool cached)
        {using var req=new HttpRequestMessage(HttpMethod.Get,url);req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",u.Token);var res=await client.SendAsync(req);Assert.Equal(200,(int)res.StatusCode);Assert.Equal("application/pdf",res.Content.Headers.ContentType!.MediaType);if(!cached){Assert.True(res.Headers.CacheControl!.Private);Assert.True(res.Headers.CacheControl.NoStore);}var bytes=await res.Content.ReadAsByteArrayAsync();Assert.Equal("%PDF",System.Text.Encoding.ASCII.GetString(bytes,0,4));await File.WriteAllBytesAsync(path,bytes);return bytes;}
        await Pdf($"/api/seller/orders/{sub}/invoice.pdf","/tmp/synthetic-seller-invoice27.pdf",false);await Pdf($"/api/seller/returns/{ret}/credit-note.pdf","/tmp/synthetic-seller-credit27.pdf",true);
        Assert.Equal(200,(await customer.Get($"/api/invoices/{sub}.pdf")).Status);Assert.Equal(200,(await customer.Get($"/api/credit-notes/{ret}.pdf")).Status);
    }
}
