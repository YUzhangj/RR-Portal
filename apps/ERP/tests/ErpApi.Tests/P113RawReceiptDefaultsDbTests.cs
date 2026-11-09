using ErpApi.Engines.Authorization;
using ErpApi.Engines.Posting;
using ErpApi.Infrastructure.Db;
using Microsoft.Data.SqlClient;
using Dapper;
using ErpApi.Features.Plastics;
using ErpApi.Features.Plastics.PlasticRawMaterialPurchaseOrder;
using ErpApi.Features.Plastics.PlasticRawMaterialReceipt;

[Collection("db")]
public sealed class P113RawReceiptDefaultsDbTests(DbFixture fx)
{
    [Theory]
    [InlineData("包")]
    [InlineData(null)]
    [InlineData("  ")]
    public async Task Current_order_import_payload_uses_only_its_frozen_factor_and_preserves_opening(string? unit)
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);var order=await BagPurchase(s,c);
        var service=new PlasticRawMaterialReceiptService(s.Factory,s.NumberGenerator);
        // 当前页面的订单调入不携带每包重量，兼容只给原料、数量的 API 调用。
        var receipt=await service.CreateAsync(new(){订单单号=order,明细=[new(){原料编号=s.Raw,单位=unit,数量=3,单价=9}]},s.Clerk);
        var line=Assert.Single((await service.GetAsync(receipt))!.明细);Assert.Equal("包",line.单位);Assert.Equal(25m,line.每包重量);Assert.Equal(9m,line.单价);Assert.Equal(27m,line.金额);
        Assert.Equal(1m,await s.Stock());await s.Posting.ApproveAsync("原料入仓单",receipt,s.Keeper);Assert.Equal(4m,await s.Stock());
        Assert.Equal(1m,c.ExecuteScalar<decimal>("SELECT [期初数量] FROM [原料自动扣料期初] WHERE [原料编号]=@Raw",s));
        await s.Posting.UnapproveAsync("原料入仓单",receipt,s.Keeper);Assert.Equal(1m,await s.Stock());
    }

    [Theory]
    [InlineData("KG",25)]
    [InlineData("包",24)]
    [InlineData("包",0)]
    [InlineData("包",-1)]
    public async Task Explicit_wrong_unit_or_factor_is_never_replaced(string unit,decimal factor)
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);var order=await BagPurchase(s,c);
        var service=new PlasticRawMaterialReceiptService(s.Factory,s.NumberGenerator);
        await Assert.ThrowsAsync<InvalidOperationException>(()=>service.CreateAsync(new(){订单单号=order,明细=[new(){原料编号=s.Raw,单位=unit,每包重量=factor,数量=1}]},s.Clerk));
        Assert.Equal(0,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [原料入仓单] WHERE [订单单号]=@order",new{order}));Assert.Equal(1m,await s.Stock());
    }

    [Theory]
    [InlineData("包",50,1)]
    [InlineData("KG",1,1)]
    [InlineData("包",25,null)]
    public async Task Conflicting_frozen_sources_reject_missing_factor_without_writing_receipt(string unit,decimal factor,int? version)
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);var order=await BagPurchase(s,c);
        c.Execute("INSERT INTO [原料采购订单明细]([单号],[原料编号],[单位],[订货数量],[每库存单位KG],[采购政策版本]) VALUES(@order,@Raw,@unit,1,@factor,@version)",new{order,s.Raw,unit,factor,version});
        var service=new PlasticRawMaterialReceiptService(s.Factory,s.NumberGenerator);
        await Assert.ThrowsAsync<InvalidOperationException>(()=>service.CreateAsync(new(){订单单号=order,明细=[new(){原料编号=s.Raw,数量=1}]},s.Clerk));
        Assert.Equal(0,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [原料入仓单] WHERE [订单单号]=@order",new{order}));Assert.Equal(1m,await s.Stock());
    }

    [Fact]
    public async Task Existing_new_policy_receipt_missing_defaults_is_normalized_inside_posting_transaction()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);var order=await BagPurchase(s,c);
        var service=new PlasticRawMaterialReceiptService(s.Factory,s.NumberGenerator);
        var receipt=await service.CreateAsync(new(){订单单号=order,明细=[new(){原料编号=s.Raw,单位="包",每包重量=25,数量=3}]},s.Clerk);
        c.Execute("UPDATE [原料入仓明细单] SET [单位]=NULL,[每包重量]=NULL WHERE [单号]=@receipt",new{receipt});
        await s.Posting.ApproveAsync("原料入仓单",receipt,s.Keeper);
        var line=Assert.Single((await service.GetAsync(receipt))!.明细);Assert.Equal("包",line.单位);Assert.Equal(25m,line.每包重量);Assert.Equal(4m,await s.Stock());
    }

    [Fact]
    public async Task Posting_audit_failure_rolls_back_missing_defaults_opening_and_stock()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);var order=await BagPurchase(s,c);
        var service=new PlasticRawMaterialReceiptService(s.Factory,s.NumberGenerator);
        var receipt=await service.CreateAsync(new(){订单单号=order,明细=[new(){原料编号=s.Raw,单位="包",每包重量=25,数量=3}]},s.Clerk);
        c.Execute("UPDATE [原料入仓明细单] SET [单位]=NULL,[每包重量]=NULL WHERE [单号]=@receipt",new{receipt});
        var posting=new PostingEngine(s.Factory,new BrokenAudit());
        await Assert.ThrowsAsync<InvalidOperationException>(()=>posting.ApproveAsync("原料入仓单",receipt,s.Keeper));
        var saved=(await service.GetAsync(receipt))!;var line=Assert.Single(saved.明细);
        Assert.Null(line.单位);Assert.Null(line.每包重量);Assert.Equal("0",saved.单头!.审核);Assert.Equal(1m,await s.Stock());
        Assert.Equal(0,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [原料自动扣料期初] WHERE [原料编号]=@Raw",s));
        Assert.Equal(0,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [c操作记录] WHERE [操作员]=@Keeper AND [操作记录] LIKE @pattern",new{s.Keeper,pattern="%"+receipt+"%"}));
    }

    private sealed class BrokenAudit:IAuditLogger
    {public Task WriteAsync(string t,string a,string u,string d,SqlConnection c,SqlTransaction? tx=null)=>throw new InvalidOperationException("fixture-audit-failure");}

    [Fact]
    public async Task Legacy_null_policy_never_backfills_receipt_unit_or_weight()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);var order=s.Prefix+"OLD";
        c.Execute("INSERT INTO [原料采购订单]([单号],[审核]) VALUES(@order,N'0');INSERT INTO [原料采购订单明细]([单号],[原料编号],[单位],[订货数量]) VALUES(@order,@Raw,N'包',3)",new{order,s.Raw});
        var service=new PlasticRawMaterialReceiptService(s.Factory,s.NumberGenerator);
        var receipt=await service.CreateAsync(new(){订单单号=order,明细=[new(){原料编号=s.Raw,数量=1}]},s.Clerk);
        var line=Assert.Single((await service.GetAsync(receipt))!.明细);Assert.Null(line.单位);Assert.Null(line.每包重量);Assert.Equal(12m,await s.Stock());
    }

    private static async Task<string> BagPurchase(CloudRawFixture s,Microsoft.Data.SqlClient.SqlConnection c)
    {
        c.Execute("UPDATE [塑胶原料资料] SET [单位]=N'包',[每包重量]=25,[库存]=1 WHERE [物料编号]=@Raw",s);
        var sp=await s.Orders.CreateAsync(new(){供应商名称=s.Prefix,明细=[new(){物料编号=s.Plastic,数量=100,套数=1}]},s.Clerk);
        c.Execute("UPDATE [塑胶采购订单] SET [主管审核]=N'1',[经理审核]=N'1' WHERE [单号]=@sp",new{sp});await s.Posting.ApproveAsync("塑胶采购订单",sp,s.Manager);
        var purchase=new PlasticRawMaterialPurchaseOrderService(s.Factory,s.NumberGenerator);
        var order=await purchase.CreateAsync(new(){明细=[new(){原料编号=s.Raw,单位="包",订货数量=3}]},s.Clerk);
        c.Execute("UPDATE [原料采购订单] SET [主管审核]=N'1',[经理审核]=N'1' WHERE [单号]=@order",new{order});await s.Posting.ApproveAsync("原料采购订单",order,s.Clerk);return order;
    }
}
