using System.Security.Claims;
using Dapper;
using ErpApi.Engines.Authorization;
using ErpApi.Features.Plastics;
using ErpApi.Infrastructure.Db;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

[Collection("db")]
public sealed class P113RawRoleManagementDbTests(DbFixture fx)
{
    [Fact]
    public async Task Active_admin_assigns_and_removes_role_with_audit_without_granting_matrix_permissions()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var admin=new AdminFixture(c);
        c.Execute("UPDATE [userbqrpower] SET [审核]=0 WHERE [用户]=@Clerk AND [菜单]=N'原料出库表'",s);
        var controller=Controller(s,"admin");
        Assert.IsType<NoContentResult>(await controller.SaveRole(s.Clerk,new("06-manager")));
        Assert.Equal("06-manager",(await RawMaterialActorAccess.ResolveAsync(c,null,s.Clerk)).PositionCode);
        Assert.False(await new PermissionService(s.Factory).HasAsync(s.Clerk,"原料出库表",PermissionAction.审核));
        Assert.Equal(1,admin.Audits);
        Assert.IsType<NoContentResult>(await controller.SaveRole(s.Clerk,new(null)));
        Assert.Null((await RawMaterialActorAccess.ResolveAsync(c,null,s.Clerk)).PositionCode);
        Assert.Equal(2,admin.Audits);
    }

    [Fact]
    public async Task Locked_or_missing_real_admin_is_rejected_even_with_admin_claim_and_management_matrix()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var admin=new AdminFixture(c);
        var controller=Controller(s,"admin");
        c.Execute("UPDATE [sysfileuser] SET [锁定到期]=DATEADD(day,1,SYSDATETIME()) WHERE [ID]=@Id",admin);
        Assert.IsType<ForbidResult>(await controller.SaveRole(s.Clerk,new("06-manager")));
        c.Execute("UPDATE [sysfileuser] SET [锁定到期]=NULL,[用户]=N'review-no-admin' WHERE [ID]=@Id",admin);
        Assert.IsType<ForbidResult>(await controller.SaveRole(s.Clerk,new("06-manager")));
        Assert.Equal("06-clerk",(await RawMaterialActorAccess.ResolveAsync(c,null,s.Clerk)).PositionCode);
        Assert.Equal(0,admin.Audits);
    }

    [Fact]
    public async Task Admin_cannot_receive_regular_role_including_case_insensitive_target()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var admin=new AdminFixture(c);
        var controller=Controller(s,"admin");
        Assert.IsType<ConflictObjectResult>(await controller.SaveRole("admin",new("06-manager")));
        Assert.IsType<ConflictObjectResult>(await controller.SaveRole("ADMIN",new("05-warehouse")));
        Assert.Equal(0,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [原料流程岗位绑定] WHERE [用户ID]=@Id",admin));
        Assert.Equal(0,admin.Audits);
    }

    [Fact]
    public async Task Admin_can_remove_legacy_invalid_own_binding_without_reopening_regular_binding()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var admin=new AdminFixture(c);
        c.Execute("INSERT INTO [原料流程岗位绑定]([用户ID],[部门编号],[岗位代码]) VALUES(@Id,N'06',N'06-manager'); UPDATE [部门信息] SET [编号]=N'F06' WHERE [编号]=N'06' AND [部门]=@Prefix",new{admin.Id,s.Prefix});
        try
        {
            Assert.False((await RawMaterialActorAccess.ResolveAsync(c,null,"admin")).IsValid);
            Assert.IsType<OkObjectResult>(await Controller(s,"admin").Role("admin"));
            Assert.IsType<NoContentResult>(await Controller(s,"admin").SaveRole("admin",new(null)));
            var actor=await RawMaterialActorAccess.ResolveAsync(c,null,"admin");
            Assert.True(actor.IsAdmin);Assert.True(actor.IsValid);Assert.False(actor.IsManaged);Assert.Equal(1,admin.Audits);
        }
        finally {c.Execute("UPDATE [部门信息] SET [编号]=N'06' WHERE [编号]=N'F06' AND [部门]=@Prefix",s);}
    }

    [Fact]
    public async Task Missing_management_open_or_save_does_not_write_role()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var admin=new AdminFixture(c);
        c.Execute("UPDATE [userbqrpower] SET [保存]=0 WHERE [ID]=@PermissionId",admin);
        Assert.IsType<ForbidResult>(await Controller(s,"admin").SaveRole(s.Clerk,new("06-manager")));
        c.Execute("UPDATE [userbqrpower] SET [保存]=1,[打开]=0 WHERE [ID]=@PermissionId",admin);
        Assert.IsType<ForbidResult>(await Controller(s,"admin").SaveRole(s.Clerk,new("06-manager")));
        Assert.Equal("06-clerk",(await RawMaterialActorAccess.ResolveAsync(c,null,s.Clerk)).PositionCode);Assert.Equal(0,admin.Audits);
    }

    [Fact]
    public async Task Invalid_role_missing_target_and_locked_target_are_rejected_without_audit()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var admin=new AdminFixture(c);
        var controller=Controller(s,"admin");
        Assert.IsType<BadRequestObjectResult>(await controller.SaveRole(s.Clerk,new("not-a-role")));
        Assert.IsType<NotFoundObjectResult>(await controller.SaveRole(s.Clerk+"missing",new("06-manager")));
        c.Execute("UPDATE [sysfileuser] SET [锁定到期]=DATEADD(day,1,SYSDATETIME()) WHERE [用户]=@Clerk",s);
        Assert.IsType<ConflictObjectResult>(await controller.SaveRole(s.Clerk,new("06-manager")));
        Assert.Equal("06-clerk",c.ExecuteScalar<string>("SELECT b.[岗位代码] FROM [原料流程岗位绑定] b JOIN [sysfileuser] u ON u.[ID]=b.[用户ID] WHERE u.[用户]=@Clerk",s));Assert.Equal(0,admin.Audits);
    }

    [Fact]
    public async Task Audit_failure_rolls_back_admin_assignment_and_removal()
    {
        using var c=fx.Open();using var s=new CloudRawFixture(c,fx.ConnectionString!);using var admin=new AdminFixture(c);
        var controller=Controller(s,"admin",new BrokenAudit());
        await Assert.ThrowsAsync<InvalidOperationException>(()=>controller.SaveRole(s.Clerk,new("06-manager")));
        Assert.Equal("06-clerk",(await RawMaterialActorAccess.ResolveAsync(c,null,s.Clerk)).PositionCode);
        await Assert.ThrowsAsync<InvalidOperationException>(()=>controller.SaveRole(s.Clerk,new(null)));
        Assert.Equal("06-clerk",(await RawMaterialActorAccess.ResolveAsync(c,null,s.Clerk)).PositionCode);Assert.Equal(0,admin.Audits);
    }

    private static RawMaterialWorkflowController Controller(CloudRawFixture s,string user,IAuditLogger? audit=null)
        =>new(s.Factory,new PermissionService(s.Factory),audit??new AuditLogger())
        {ControllerContext=new(){HttpContext=new DefaultHttpContext{User=new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier,user)],"fixture"))}}};
    private sealed class BrokenAudit:IAuditLogger
    {public Task WriteAsync(string t,string a,string u,string d,SqlConnection c,SqlTransaction? tx=null)=>throw new InvalidOperationException("fixture-audit-failure");}
    private sealed class AdminFixture:IDisposable
    {
        private readonly SqlConnection c;private readonly long auditStart;
        public long Id{get;}public long PermissionId{get;}
        public int Audits=>c.ExecuteScalar<int>("SELECT COUNT(*) FROM [c操作记录] WHERE [ID]>@auditStart AND [操作员]=N'admin'",new{auditStart});
        public AdminFixture(SqlConnection c)
        {
            this.c=c;Assert.Equal(0,c.ExecuteScalar<int>("SELECT COUNT(*) FROM [sysfileuser] WHERE [用户] IN(N'admin',N'review-no-admin')"));
            auditStart=c.ExecuteScalar<long>("SELECT ISNULL(MAX([ID]),0) FROM [c操作记录]");
            Id=c.ExecuteScalar<long>("INSERT INTO [sysfileuser]([用户],[密码],[登录状态],[登录失败次数]) OUTPUT INSERTED.[ID] VALUES(N'admin',N'fixture-only-not-login',N'',0)");
            PermissionId=c.ExecuteScalar<long>("INSERT INTO [userbqrpower]([用户],[菜单],[打开],[保存]) OUTPUT INSERTED.[ID] VALUES(N'admin',N'账号管理',1,1)");
        }
        public void Dispose()=>c.Execute("DELETE FROM [c操作记录] WHERE [ID]>@auditStart AND [操作员]=N'admin'; DELETE FROM [原料流程岗位绑定] WHERE [用户ID]=@Id; DELETE FROM [userbqrpower] WHERE [ID]=@PermissionId; DELETE FROM [sysfileuser] WHERE [ID]=@Id",new{auditStart,Id,PermissionId});
    }
}
