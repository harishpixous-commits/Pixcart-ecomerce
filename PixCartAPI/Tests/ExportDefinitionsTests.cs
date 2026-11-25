using Utils;
namespace Tests;
public class ExportDefinitionsTests
{
    private static ExportDefinitions.Spec Get(string name, string scope="admin") => ExportDefinitions.All.Single(s => s.Name==name && s.Scope==scope);
    [Fact]
    public void Registry_keeps_every_source_scope_permission_header_and_filter()
    {
        Assert.Equal(12,ExportDefinitions.All.Count(s=>s.Scope=="admin")); Assert.Equal(7,ExportDefinitions.All.Count(s=>s.Scope=="seller"));
        Assert.Equal("orders",Get("orders").Permission); Assert.Equal("reports",Get("order-items").Permission);
        Assert.Equal(30,Get("orders").Headers.Count); Assert.Equal(24,Get("order-items").Headers.Count);
        Assert.Equal(new[]{"sku","warehouse_code","quantity"},Get("stock").Headers.Take(3));
        Assert.DoesNotContain("seller",Get("orders","seller").Filters); Assert.Contains("seller",Get("orders").Filters);
        Assert.True(Get("customers").PersonalData); Assert.True(Get("sellers").DateOptional);
        foreach(var spec in ExportDefinitions.All)
        {
            var description=ExportDefinitions.Describe(spec);
            Assert.Equal(spec.Headers.Count,description["columns"]!.AsArray().Count);
            Assert.Equal(3,description["formats"]!.AsArray().Count);
            Assert.Equal(14,description["pdf_max_columns"]!.GetValue<int>());
            Assert.All(ExportDefinitions.DefaultPdfColumns(spec),h=>Assert.Contains(h,spec.Headers));
        }
        Assert.Equal("choice",ExportDefinitions.Describe(Get("orders"))["filters"]![1]!["kind"]!.GetValue<string>());
    }
    [Fact]
    public void Date_defaults_and_inclusive_IST_boundaries_match_source()
    {
        var context=ExportDefinitions.Parse(Get("orders"),today:new(2026,11,24));
        Assert.Equal(new DateTimeOffset(2026,10,24,18,30,0,TimeSpan.Zero),context.Start);
        Assert.Equal(new DateTimeOffset(2026,11,24,18,30,0,TimeSpan.Zero),context.End);
        Assert.Equal("2026-10-25-to-2026-11-24",ExportDefinitions.PeriodLabel(context));
        Assert.Null(ExportDefinitions.Parse(Get("customers")).Start);
        Assert.Null(ExportDefinitions.Parse(Get("products"),from:new(2026,1,1),to:new(2026,2,1)).Start);
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.Parse(Get("orders"),from:new(2026,1,2),to:new(2026,1,1)));
        Assert.NotNull(ExportDefinitions.Parse(Get("orders"),from:new(2025,11,24),to:new(2026,11,24)).Start);
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.Parse(Get("orders"),from:new(2025,11,23),to:new(2026,11,24)));
        Assert.Equal("2026-01",ExportDefinitions.Parse(Get("tcs"),month:"2026-01").Month);
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.Parse(Get("tcs"),month:"2026-13"));
    }
    [Fact]
    public void Extra_filters_validate_scope_values_whitespace_and_whole_stock()
    {
        var seller=Guid.NewGuid();var context=ExportDefinitions.Parse(Get("products"),extra:new Dictionary<string,string?>{["seller"]=seller.ToString(),["q"]="  Cotton\n   blue  ",["low_stock"]="0"});
        Assert.Equal(seller,context.Extra["seller"]);Assert.Equal("Cotton blue",context.Extra["q"]);Assert.Equal(0,context.Extra["low_stock"]);
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.Parse(Get("products","seller"),extra:new Dictionary<string,string?>{["seller"]=seller.ToString()}));
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.Parse(Get("products"),extra:new Dictionary<string,string?>{["low_stock"]="0.1"}));
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.Parse(Get("products"),extra:new Dictionary<string,string?>{["low_stock"]="100001"}));
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.Parse(Get("orders"),extra:new Dictionary<string,string?>{["payment_method"]="wire"}));
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.Parse(Get("orders"),status:"pending_payment"));
        Assert.Equal("placed",ExportDefinitions.Parse(Get("orders"),status:"placed").Status);
    }
    [Fact]
    public void Columns_keep_export_order_deduplicate_and_apply_pdf_limits()
    {
        var spec=Get("orders");
        Assert.Equal(new[]{0,1},ExportDefinitions.PickColumns(spec,["Order","Package","Order"],"csv"));
        Assert.Equal(11,ExportDefinitions.PickColumns(spec,[],"pdf").Count);
        Assert.Equal(30,ExportDefinitions.PickColumns(spec,[],"xlsx").Count);
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.PickColumns(spec,["missing"],"csv"));
        Assert.Throws<ArgumentException>(()=>ExportDefinitions.PickColumns(spec,spec.Headers,"pdf"));
    }
    [Fact]
    public void Filenames_and_filter_summary_use_local_dates_names_and_privacy_labels()
    {
        var spec=Get("orders");var seller=Guid.NewGuid();var context=ExportDefinitions.Parse(spec,from:new(2026,11,1),to:new(2026,11,2),status:"packed",extra:new Dictionary<string,string?>{["seller"]=seller.ToString(),["payment_method"]="cod"});
        Assert.Equal("synthetic-brand-orders-2026-11-01-to-2026-11-02.csv",ExportDefinitions.FileName("Synthetic Brand",spec,context,"csv"));
        var summary=ExportDefinitions.Summary(spec,context,new Dictionary<string,string>{["seller"]="Synthetic Seller"});
        Assert.Contains(("Dates (date the order was placed)","01 Nov 2026 to 02 Nov 2026"),summary); Assert.Contains(("Seller","Synthetic Seller"),summary); Assert.Contains(("Payment","Cash on delivery"),summary); Assert.Contains(("Status","Packed"),summary);
        Assert.Equal("export-stock-2026-11-24.csv",ExportDefinitions.FileName("தமிழ்",Get("stock"),ExportDefinitions.Parse(Get("stock")),"csv",new(2026,11,24)));
    }
}
