using System.Security.Claims;
using Dapper;
using ErpApi.Engines.Authorization;
using ErpApi.Engines.Inventory;
using ErpApi.Features.Plastics.PlasticRawMaterialStocktake;
using ErpApi.Infrastructure.Db;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

[Collection("db")]
public sealed class P113RawStocktakeDuplicateDbTests(DbFixture fx)
{
    [Theory]
    [InlineData("same")]
    [InlineData("case")]
    [InlineData("trailing")]
    public async Task Ledger_duplicate_create_is_atomic_and_respects_SQL_code_equality(string variant)
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var cleanup=new CountCleanup(c,s);
        await Enable(c,s);var service=Service(s);var other=variant=="case"?s.Raw.ToLowerInvariant():variant=="trailing"?s.Raw+" ":s.Raw;
        Assert.Equal(1,c.ExecuteScalar<int>("SELECT CASE WHEN @Raw=@other THEN 1 ELSE 0 END",new{s.Raw,other}));
        await Assert.ThrowsAsync<InvalidOperationException>(()=>service.CreateAsync(Count(s.Raw,other),s.Clerk));
        Assert.Equal(0,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [原料盘点单] WHERE [单号] LIKE @Like",s));
        Assert.Equal(0,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [原料盘点明细单] WHERE [单号] LIKE @Like",s));
        Assert.Equal(10m,await s.Stock());Assert.Equal(0,Audits(c,s));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Approval_rechecks_saved_duplicates_including_mixed_flags_without_posting(bool secondLedger)
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var cleanup=new CountCleanup(c,s);
        await Enable(c,s);var service=Service(s);var number=await service.CreateAsync(Count(s.Raw),s.Clerk);
        c.Execute("INSERT INTO [原料盘点明细单]([单号],[原料编号],[系统数量],[盘点数量],[盈亏数量],[原料台账盘点]) VALUES(@number,@code,10,12,2,@secondLedger)",new{number,code=s.Raw.ToLowerInvariant()+" ",secondLedger});
        await Assert.ThrowsAsync<InvalidOperationException>(()=>service.ApproveAsync(number,s.Keeper));
        var detail=(await service.GetAsync(number))!;Assert.Equal("0",detail.单头!.审核);Assert.Equal(2,detail.明细.Count);
        Assert.Equal(10m,await s.Stock());Assert.Equal(0,Audits(c,s));
    }

    [Fact]
    public async Task Single_ledger_count_and_reversal_preserve_exact_opening_and_audit()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var cleanup=new CountCleanup(c,s);
        await Enable(c,s);var service=Service(s);var number=await service.CreateAsync(Count(s.Raw),s.Clerk);
        Assert.True(await service.ApproveAsync(number,s.Keeper));Assert.Equal(12m,await s.Stock());Assert.Equal(1,Audits(c,s));
        Assert.True(await service.UnapproveAsync(number,s.Keeper));Assert.Equal(10m,await s.Stock());Assert.Equal(2,Audits(c,s));
        Assert.Equal(10m,c.ExecuteScalar<decimal>("SELECT [期初数量] FROM [原料自动扣料期初] WHERE [原料编号]=@Raw",s));
    }

    [Fact]
    public async Task Legacy_duplicate_count_and_reversal_keep_original_path()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var cleanup=new CountCleanup(c,s);
        c.Execute("UPDATE [塑胶原料资料] SET [库存]=10 WHERE [物料编号]=@Raw",s);var service=Service(s);
        var number=await service.CreateAsync(Count(s.Raw,s.Raw),s.Clerk);
        Assert.True(await service.ApproveAsync(number,s.Keeper));
        Assert.Equal(12m,c.ExecuteScalar<decimal>("SELECT [库存] FROM [塑胶原料资料] WHERE [物料编号]=@Raw",s));
        Assert.True(await service.UnapproveAsync(number,s.Keeper));Assert.Equal(10m,c.ExecuteScalar<decimal>("SELECT [库存] FROM [塑胶原料资料] WHERE [物料编号]=@Raw",s));
        Assert.Equal(0,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [原料自动扣料期初] WHERE [原料编号]=@Raw",s));Assert.Equal(2,Audits(c,s));
    }

    [Fact]
    public async Task Late_audit_failure_rolls_back_ledger_count_posting()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var cleanup=new CountCleanup(c,s);
        await Enable(c,s);var number=await Service(s).CreateAsync(Count(s.Raw),s.Clerk);
        await Assert.ThrowsAsync<InvalidOperationException>(()=>Service(s,new BrokenAudit()).ApproveAsync(number,s.Keeper));
        Assert.Equal("0",(await Service(s).GetAsync(number))!.单头!.审核);Assert.Equal(10m,await s.Stock());Assert.Equal(0,Audits(c,s));
    }

    [Fact]
    public async Task Controller_returns_409_for_duplicate_create_and_final_approval_and_keeps_permission_guard()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var cleanup=new CountCleanup(c,s);await Enable(c,s);
        c.Execute("DELETE FROM [userbqrpower] WHERE [用户]=@Clerk AND [菜单]=N'原料盘点单'",s);
        var controller=new PlasticRawMaterialStocktakeController(Service(s),new PermissionService(s.Factory))
        {ControllerContext=new(){HttpContext=new DefaultHttpContext{User=new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier,s.Clerk)],"fixture"))}}};
        Assert.IsType<ForbidResult>(await controller.Create(Count(s.Raw,s.Raw)));
        c.Execute("INSERT INTO [userbqrpower]([用户],[菜单],[打开],[保存],[审核]) VALUES(@Clerk,N'原料盘点单',1,1,1)",s);
        Assert.IsType<ConflictObjectResult>(await controller.Create(Count(s.Raw,s.Raw)));
        var number=await Service(s).CreateAsync(Count(s.Raw),s.Clerk);
        c.Execute("INSERT INTO [原料盘点明细单]([单号],[原料编号],[系统数量],[盘点数量],[盈亏数量],[原料台账盘点]) VALUES(@number,@Raw,10,12,2,1)",new{number,s.Raw});
        Assert.IsType<ConflictObjectResult>(await controller.Approve(number));Assert.Equal(10m,await s.Stock());Assert.Equal(0,Audits(c,s));
    }

    [Theory]
    [InlineData("保存", "保存")]
    [InlineData("审核", "审核")]
    [InlineData("反审核", "反审核")]
    [InlineData("删除", "删除")]
    [InlineData("保存", "打开")]
    [InlineData("审核", "锁定")]
    public async Task Permission_revoked_while_waiting_for_inventory_lock_prevents_final_transaction(string action,string revoke)
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var cleanup=new CountCleanup(c,s);await Enable(c,s);
        var service=Service(s);var number=action=="保存"?null:await service.CreateAsync(Count(s.Raw),s.Clerk);
        if(action=="反审核")Assert.True(await service.ApproveAsync(number!,s.Clerk));
        var beforeStock=await s.Stock();var beforeAudits=Audits(c,s);
        var controller=new PlasticRawMaterialStocktakeController(service,new PermissionService(s.Factory))
        {ControllerContext=new(){HttpContext=new DefaultHttpContext{User=new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier,s.Clerk)],"fixture"))}}};
        using var blocker=s.Factory.Create();await blocker.OpenAsync();using var tx=blocker.BeginTransaction();
        await RawMaterialInventorySql.LockCodesAsync(blocker,tx,[s.Raw]);
        var blockerId=await blocker.ExecuteScalarAsync<int>("SELECT @@SPID",transaction:tx);
        var pending=action switch{"保存"=>controller.Create(Count(s.Raw)),"审核"=>controller.Approve(number!),"反审核"=>controller.Unapprove(number!),_=>controller.Delete(number!)};
        var blocked=false;
        for(var i=0;i<250;i++)
        {
            blocked=await c.ExecuteScalarAsync<bool>("SELECT CASE WHEN EXISTS(SELECT 1 FROM sys.dm_exec_requests WHERE blocking_session_id=@blockerId AND wait_type LIKE N'LCK_M_%') THEN 1 ELSE 0 END",new{blockerId});
            if(blocked)break;await Task.Delay(20);
        }
        Assert.True(blocked,"operation must reach and wait on the owned inventory lock before revocation");Assert.False(pending.IsCompleted);
        if(revoke=="锁定")c.Execute("UPDATE [sysfileuser] SET [锁定到期]=DATEADD(day,1,SYSDATETIME()) WHERE [用户]=@Clerk",s);
        else c.Execute($"UPDATE [userbqrpower] SET [{revoke}]=0 WHERE [用户]=@Clerk AND [菜单]=N'原料盘点单'",s);
        tx.Commit();Assert.IsType<ForbidResult>(await pending);
        Assert.Equal(beforeStock,await s.Stock());Assert.Equal(beforeAudits,Audits(c,s));
        Assert.Equal(number is null?0:1,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [原料盘点单] WHERE [单号] LIKE @Like",s));
        if(number is not null)Assert.Equal(action=="反审核"?"1":"0",(await service.GetAsync(number))!.单头!.审核);
    }

    private static PlasticRawMaterialStocktakeService Service(CloudRawFixture s,IAuditLogger? audit=null)=>new(s.Factory,s.NumberGenerator,audit??new AuditLogger());
    private static PlasticRawMaterialStocktakeCreateDto Count(params string[] codes)=>new(){明细=codes.Select(code=>new PlasticRawMaterialStocktakeCreateLineDto{原料编号=code,盘点数量=12,系统数量=999}).ToList()};
    private static async Task Enable(SqlConnection c,CloudRawFixture s)
    {c.Execute("INSERT INTO [userbqrpower]([用户],[菜单],[打开],[保存],[审核],[反审核],[删除]) VALUES(@Clerk,N'原料盘点单',1,1,1,1,1),(@Keeper,N'原料盘点单',1,1,1,1,1);UPDATE [塑胶原料资料] SET [库存]=10 WHERE [物料编号]=@Raw",s);using var tx=c.BeginTransaction();await RawMaterialInventorySql.ActivateAsync(c,tx,s.Raw,"KG",1);tx.Commit();}
    private static int Audits(SqlConnection c,CloudRawFixture s)=>c.ExecuteScalar<int>("SELECT COUNT(*) FROM [c操作记录] WHERE [操作员] IN @Users",s);
    private sealed class CountCleanup(SqlConnection c,CloudRawFixture s):IDisposable
    {public void Dispose()=>c.Execute("DELETE FROM [原料盘点明细单] WHERE [单号] LIKE @Like;DELETE FROM [原料盘点单] WHERE [单号] LIKE @Like",s);}
    private sealed class BrokenAudit:IAuditLogger
    {public Task WriteAsync(string t,string a,string u,string d,SqlConnection c,SqlTransaction? tx=null)=>throw new InvalidOperationException("fixture-audit-failure");}
}
