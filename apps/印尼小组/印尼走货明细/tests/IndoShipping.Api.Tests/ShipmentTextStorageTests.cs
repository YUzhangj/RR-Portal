using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using IndoShipping.Api.Controllers;
using IndoShipping.Api.Features.Bootstrap;
using IndoShipping.Domain.Entities;
using IndoShipping.Infrastructure.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using Xunit;

namespace IndoShipping.Api.Tests;

public class ShipmentTextStorageTests
{
    private const string ConnectionVariable = "SHIPMENT_TEXT_TEST_CONNECTION";
    private static readonly string[] TextColumns = ["qty_per_carton", "pallet", "po_no", "contract_no", "invoice_no"];

    [ShipmentTextTheory]
    [InlineData("qty_per_carton")]
    [InlineData("pallet")]
    [InlineData("po_no")]
    [InlineData("contract_no")]
    [InlineData("invoice_no")]
    public async Task Legacy_64_character_failure_is_reproduced_then_POST_and_PUT_preserve_complete_text(string field)
    {
        await using var f = await Fixture.Create(legacy: true);
        await using var host = await HttpHost.Start(f.Connection);
        var body = Body();
        Set(body.items![0], field, new string('字', 65));
        var before = await f.Snapshot();
        Assert.Equal(HttpStatusCode.InternalServerError, (await host.Client.PostAsJsonAsync("/api/shipments", body)).StatusCode);
        Assert.Equal(before, await f.Snapshot());

        await f.Migrate();
        var created = await host.Client.PostAsJsonAsync("/api/shipments", body);
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        await AssertText(host.Client, f, id, field, new string('字', 65));
        // Unpredictable Unicode document references must also survive the old B-tree
        // tuple-size boundary. Repeated filler would compress and miss this failure.
        var complete = LongText(field);
        Set(body.items[0], field, complete);
        (await host.Client.PutAsJsonAsync($"/api/shipments/{id}", body)).EnsureSuccessStatusCode();
        await AssertText(host.Client, f, id, field, complete);
        Assert.Equal(2m, await f.Db.ExecuteScalarAsync<decimal>("SELECT qty FROM shipment_items WHERE shipment_id=@id", new { id }));
        Assert.Equal(4m, await f.Db.ExecuteScalarAsync<decimal>("SELECT kg FROM shipment_items WHERE shipment_id=@id", new { id }));
    }

    [ShipmentTextFact]
    public async Task Migration_preserves_existing_rows_NULL_empty_zero_and_is_repeatable()
    {
        await using var f = await Fixture.Create(legacy: true);
        var before = await f.Snapshot();
        await f.Migrate();
        Assert.Equal(before, await f.Snapshot());
        var firstIndex = await f.Index();
        Assert.Contains("USING hash (po_no)", firstIndex.Definition);
        Assert.Equal(5, await f.Db.ExecuteScalarAsync<int>("""
            SELECT count(*) FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='shipment_items'
              AND column_name=ANY(@columns) AND data_type='text' AND character_maximum_length IS NULL
            """, new { columns = TextColumns }));
        Assert.Equal(64, await f.Db.ExecuteScalarAsync<int>("""
            SELECT character_maximum_length FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='shipment_items' AND column_name='carton_group'
            """));
        await f.Migrate();
        Assert.Equal(before, await f.Snapshot());
        Assert.Equal(firstIndex, await f.Index());

        // Exercise the actual startup entry twice against this isolated database.
        // A permissive hand-written fixture using unbounded text would hide the
        // production failure.
        await f.Bootstrap();
        await f.Bootstrap();
        Assert.Equal(before, await f.Snapshot());
        Assert.Equal(firstIndex, await f.Index());
    }

    [ShipmentTextFact]
    public async Task Fresh_database_and_EF_model_use_text_and_nonunique_hash_index()
    {
        await using var f = await Fixture.Create(legacy: false);
        await using var context = f.Context();
        var entity = context.GetService<IDesignTimeModel>().Model.FindEntityType(typeof(ShipmentItem))!;
        foreach (var property in new[] { "QtyPerCarton", "Pallet", "PoNo", "ContractNo", "InvoiceNo" })
        {
            Assert.Equal("text", entity.FindProperty(property)!.GetColumnType());
            Assert.Null(entity.FindProperty(property)!.GetMaxLength());
        }
        Assert.Equal("hash", entity.GetIndexes().Single(i => i.Properties.Count == 1 && i.Properties[0].Name == "PoNo").GetMethod());
        var index = await f.Index();
        Assert.Contains("USING hash (po_no)", index.Definition);
        Assert.False(await f.Db.ExecuteScalarAsync<bool>("SELECT indisunique FROM pg_index WHERE indexrelid::bigint=@oid", new { oid = (long)index.Oid }));
    }

    [ShipmentTextFact]
    public async Task Long_linked_documents_roundtrip_without_changing_stock_and_failed_update_is_atomic()
    {
        await using var f = await Fixture.Create(legacy: true);
        var protectedBefore = await f.ProtectedSnapshot();
        await f.Migrate();
        await using var host = await HttpHost.Start(f.Connection);
        var body = Body(linked: true);
        foreach (var field in TextColumns) Set(body.items![0], field, LongText(field));
        var created = await host.Client.PostAsJsonAsync("/api/shipments", body);
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        foreach (var field in TextColumns) await AssertText(host.Client, f, id, field, LongText(field));
        var saved = await f.Db.QuerySingleAsync("SELECT outbound_id,material_id,qty,kg,price,currency FROM shipment_items WHERE shipment_id=@id", new { id });
        Assert.Equal(1, (int)saved.outbound_id);
        Assert.Equal(66, (int)saved.material_id);
        Assert.Equal(2m, (decimal)saved.qty);
        Assert.Equal(4m, (decimal)saved.kg);
        Assert.Equal(0m, (decimal)saved.price);
        Assert.Equal("¥", (string)saved.currency);
        Assert.Equal(protectedBefore, await f.ProtectedSnapshot());

        // Equality and ANY consumers retain exact semantics for long references.
        var po = LongText("po_no");
        Assert.Equal(1, await f.Db.ExecuteScalarAsync<int>("SELECT count(*) FROM shipment_items WHERE po_no=@po", new { po }));
        Assert.Equal(1, await f.Db.ExecuteScalarAsync<int>("SELECT count(*) FROM shipment_items WHERE po_no=ANY(@refs)", new { refs = new[] { "unmatched", po } }));
        Assert.Equal(0, await f.Db.ExecuteScalarAsync<int>("SELECT count(*) FROM shipment_items WHERE po_no=@po", new { po = po + "different" }));

        await f.Db.ExecuteAsync("ALTER TABLE shipment_items ADD CONSTRAINT synthetic_reject CHECK (invoice_no <> 'reject-update')");
        var beforeFailure = await f.Snapshot();
        body.items![0].invoice_no = "reject-update";
        body.items[0].qty_per_carton = LongText("changed-packing");
        Assert.Equal(HttpStatusCode.InternalServerError, (await host.Client.PutAsJsonAsync($"/api/shipments/{id}", body)).StatusCode);
        Assert.Equal(beforeFailure, await f.Snapshot());
        Assert.Equal(protectedBefore, await f.ProtectedSnapshot());
    }

    [ShipmentTextFact]
    public async Task Unexpected_named_index_is_rejected_without_changing_columns_or_rows()
    {
        await using var f = await Fixture.Create(legacy: true);
        await f.Db.ExecuteAsync("DROP INDEX \"IX_shipment_items_po_no\"; CREATE INDEX \"IX_shipment_items_po_no\" ON shipment_items(po_no,seq)");
        var before = await f.Snapshot();
        var beforeTypes = await f.Types();
        var beforeIndex = await f.Index();
        var error = await Assert.ThrowsAsync<PostgresException>(() => f.Migrate());
        Assert.Equal(PostgresErrorCodes.RaiseException, error.SqlState);
        Assert.Contains("Unexpected IX_shipment_items_po_no definition", error.MessageText);
        Assert.Equal(before, await f.Snapshot());
        Assert.Equal(beforeTypes, await f.Types());
        Assert.Equal(beforeIndex, await f.Index());
    }

    [ShipmentTextTheory]
    [InlineData("po_no")]
    [InlineData("lower(po_no)")]
    [InlineData("contract_no")]
    public async Task Unexpected_additional_text_index_is_preserved_and_blocks_migration(string expression)
    {
        await using var f = await Fixture.Create(legacy: true);
        Assert.Contains(expression, new[] { "po_no", "lower(po_no)", "contract_no" });
        await f.Db.ExecuteAsync($"CREATE INDEX synthetic_extra_po ON shipment_items({expression})");
        var before = await f.Types();
        var index = await f.Index();
        var error = await Assert.ThrowsAsync<PostgresException>(() => f.Migrate());
        Assert.Contains("Unexpected additional shipment text index", error.MessageText);
        Assert.Equal(before, await f.Types());
        Assert.Equal(index, await f.Index());
        Assert.NotNull(await f.Db.ExecuteScalarAsync<string>("SELECT pg_get_indexdef('synthetic_extra_po'::regclass)"));
    }

    [ShipmentTextFact]
    public async Task Short_caller_lock_timeout_does_not_partially_apply_migration()
    {
        await using var f = await Fixture.Create(legacy: true);
        var before = await f.Snapshot();
        var beforeTypes = await f.Types();
        var beforeIndex = await f.Index();
        await using var blocker = new NpgsqlConnection(f.Connection);
        await blocker.OpenAsync();
        await using var held = await blocker.BeginTransactionAsync();
        await blocker.ExecuteAsync("LOCK TABLE shipment_items IN SHARE MODE", transaction: held);
        await using var tx = await f.Db.BeginTransactionAsync();
        await f.Db.ExecuteAsync("SET LOCAL lock_timeout='200ms'", transaction: tx);
        var error = await Assert.ThrowsAsync<PostgresException>(() => f.Db.ExecuteAsync(Fixture.MigrationSql(), transaction: tx));
        Assert.Equal(PostgresErrorCodes.LockNotAvailable, error.SqlState);
        await tx.RollbackAsync();
        await held.RollbackAsync();
        Assert.Equal(before, await f.Snapshot());
        Assert.Equal(beforeTypes, await f.Types());
        Assert.Equal(beforeIndex, await f.Index());
    }

    [ShipmentTextFact]
    public async Task Already_applied_migration_does_not_wait_for_a_DDL_lock()
    {
        await using var f = await Fixture.Create(legacy: false);
        await using var blocker = new NpgsqlConnection(f.Connection);
        await blocker.OpenAsync();
        await using var held = await blocker.BeginTransactionAsync();
        await blocker.ExecuteAsync("LOCK TABLE shipment_items IN SHARE MODE", transaction: held);
        await using var tx = await f.Db.BeginTransactionAsync();
        await f.Db.ExecuteAsync("SET LOCAL lock_timeout='200ms'", transaction: tx);
        await f.Db.ExecuteAsync(Fixture.MigrationSql(), transaction: tx);
        await tx.CommitAsync();
    }

    [ShipmentTextFact]
    public async Task Long_incompressible_PO_reproduces_old_Btree_limit_and_hash_migration_removes_it()
    {
        await using var f = await Fixture.Create(legacy: true);
        await f.Db.ExecuteAsync("ALTER TABLE shipment_items ALTER COLUMN po_no TYPE text");
        var po = LongText("incompressible-PO");
        var error = await Assert.ThrowsAsync<PostgresException>(() => f.Db.ExecuteAsync(
            "INSERT INTO shipment_items(shipment_id,po_no) VALUES (100,@po)", new { po }));
        Assert.Equal(PostgresErrorCodes.ProgramLimitExceeded, error.SqlState);
        await f.Migrate();
        await f.Db.ExecuteAsync("INSERT INTO shipment_items(shipment_id,po_no) VALUES (100,@po)", new { po });
        Assert.Equal(po, await f.Db.ExecuteScalarAsync<string>("SELECT po_no FROM shipment_items WHERE po_no=@po", new { po }));
    }

    [ShipmentTextFact]
    public async Task Unexpected_column_type_is_rejected_before_other_columns_or_index_change()
    {
        await using var f = await Fixture.Create(legacy: true);
        await f.Db.ExecuteAsync("ALTER TABLE shipment_items ALTER COLUMN pallet TYPE varchar(63)");
        var beforeTypes = await f.Types();
        var beforeIndex = await f.Index();
        var error = await Assert.ThrowsAsync<PostgresException>(() => f.Migrate());
        Assert.Contains("Unexpected shipment text column type: pallet", error.MessageText);
        Assert.Equal(beforeTypes, await f.Types());
        Assert.Equal(beforeIndex, await f.Index());
    }

    private static ShipmentsController.ShBody Body(bool linked = false) => new()
    {
        customer = "RRI", container_no = "SYNTHETIC-TEXT", container_count = 1,
        items = [new() {
            material_id = 66, outbound_id = linked ? 1 : null, qty = 2, kg = 4, cartons = 1,
            price = 0, currency = "¥", purchase_unit = "个", qty_per_carton = "2", pallet = "P1",
            po_no = "SHORT-PO", contract_no = "C1", invoice_no = "I1"
        }]
    };

    private static string LongText(string prefix) => prefix + "\n" + string.Join("\n", Enumerable.Range(0, 200).Select(i =>
        "第" + i + "段 " + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(prefix + ":" + i))))) + "\n尾行🌏";

    private static void Set(ShipmentsController.ShItem item, string field, string value)
        => typeof(ShipmentsController.ShItem).GetProperty(field)!.SetValue(item, value);

    private static async Task AssertText(HttpClient client, Fixture f, int id, string field, string expected)
    {
        var document = await client.GetFromJsonAsync<JsonElement>($"/api/shipments/{id}");
        Assert.Equal(expected, document.GetProperty("items")[0].GetProperty(field).GetString());
        // Column identifier comes only from this test's fixed allowlist.
        Assert.Contains(field, TextColumns);
        Assert.Equal(expected, await f.Db.ExecuteScalarAsync<string>($"SELECT {field} FROM shipment_items WHERE shipment_id=@id", new { id }));
    }

    private sealed class Fixture : IAsyncDisposable
    {
        public required NpgsqlConnection Db { get; init; }
        public required string Connection { get; init; }
        public required string Schema { get; init; }
        public required string Database { get; init; }
        public required string AdminConnection { get; init; }
        public AppDbContext Context() => new(new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(Connection).Options);
        public Task Migrate() => Db.ExecuteAsync(MigrationSql());
        public async Task Bootstrap()
        {
            await using var context = Context();
            await DatabaseCompatibility.EnsureAsync(context);
        }
        public Task<string?> Types() => Db.ExecuteScalarAsync<string>("""
            SELECT jsonb_agg(jsonb_build_object('column',attname,'type',format_type(atttypid,atttypmod)) ORDER BY attname)::text
            FROM pg_attribute WHERE attrelid='shipment_items'::regclass AND NOT attisdropped AND attnum>0
            """);
        public async Task<(uint Oid, string Definition)> Index()
        {
            var value = await Db.QuerySingleAsync("SELECT '" + Schema + ".\"IX_shipment_items_po_no\"'::regclass::oid AS oid,pg_get_indexdef('" + Schema + ".\"IX_shipment_items_po_no\"'::regclass) AS definition");
            return ((uint)value.oid, (string)value.definition);
        }
        public Task<string?> ProtectedSnapshot() => Db.ExecuteScalarAsync<string>("""
            SELECT jsonb_build_object(
                'materials',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM materials x),
                'outbound',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM outbound x),
                'receipts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM po_receipts x),
                'purchase_orders',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM purchase_orders x),
                'po_items',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM po_items x))::text
            """);
        public Task<string?> Snapshot() => Db.ExecuteScalarAsync<string>("""
            SELECT jsonb_build_object(
                'shipments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM shipments x),
                'items',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM shipment_items x),
                'audit',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM audit_logs x),
                'materials',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM materials x),
                'outbound',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM outbound x),
                'receipts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM po_receipts x),
                'purchase_orders',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM purchase_orders x),
                'po_items',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM po_items x))::text
            """);
        public static string MigrationSql()
        {
            var schema = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "db", "postgres_schema.sql"));
            const string start = "-- BEGIN shipment-detail-text-20261102";
            const string end = "-- END shipment-detail-text-20261102";
            var offset = schema.IndexOf(start, StringComparison.Ordinal);
            Assert.True(offset >= 0);
            var length = schema.IndexOf(end, offset, StringComparison.Ordinal) - offset;
            Assert.True(length > 0);
            return schema.Substring(offset, length);
        }
        public static async Task<Fixture> Create(bool legacy)
        {
            var connection = Environment.GetEnvironmentVariable(ConnectionVariable)!;
            var parsed = new NpgsqlConnectionStringBuilder(connection);
            Assert.True(parsed.Host is "127.0.0.1" or "localhost" or "::1", "Shipment text tests require an explicit loopback-only test server");
            var database = "shipment_text_test_" + Guid.NewGuid().ToString("N");
            var adminCs = new NpgsqlConnectionStringBuilder(connection) { SearchPath = "", Pooling = false }.ConnectionString;
            await using (var admin = new NpgsqlConnection(adminCs))
            {
                await admin.OpenAsync();
                await admin.ExecuteAsync($"CREATE DATABASE {database} TEMPLATE template0");
            }
            const string schema = "indo_shipping";
            var cs = new NpgsqlConnectionStringBuilder(connection) { Database = database, SearchPath = schema, Pooling = false }.ConnectionString;
            var db = new NpgsqlConnection(cs);
            await db.OpenAsync();
            var f = new Fixture { Db = db, Connection = cs, Schema = schema, Database = database, AdminConnection = adminCs };
            try
            {
                await using var context = f.Context();
                await f.Bootstrap();
                await DataMigrations.ApplyAsync(context, NullLogger.Instance);
                await db.ExecuteAsync("""
                    INSERT INTO materials(id,name_zh) VALUES (66,'Synthetic long-text material');
                    INSERT INTO purchase_orders(id,po_no) VALUES (1,'SHORT-PO');
                    INSERT INTO po_items(id,po_id,material_id,qty,price,purchase_unit) VALUES (1,1,66,100,0,'个');
                    INSERT INTO po_receipts(id,po_item_id,receipt_date,qty,spare_qty) VALUES (1,1,CURRENT_DATE,100,0);
                    INSERT INTO outbound(id,material_id,po_item_id,qty,po_no) VALUES (1,66,1,100,'SHORT-PO');
                    INSERT INTO shipments(id,customer,container_no) VALUES (100,'RRI','PRESERVE');
                    INSERT INTO shipment_items(shipment_id,material_id,seq,kg,qty,cartons,weighing_qty,price,
                        qty_per_carton,pallet,po_no,contract_no,invoice_no)
                    VALUES (100,66,1,0,0,0,0,0,NULL,'','SHORT-PO','原合同','原发票'),
                        (100,66,2,NULL,NULL,NULL,NULL,NULL,'','原卡板',NULL,'',NULL);
                    """);
                if (legacy)
                {
                    await db.ExecuteAsync("""
                        DROP INDEX "IX_shipment_items_po_no";
                        ALTER TABLE shipment_items ALTER COLUMN qty_per_carton TYPE varchar(64),
                            ALTER COLUMN pallet TYPE varchar(64), ALTER COLUMN po_no TYPE varchar(64),
                            ALTER COLUMN contract_no TYPE varchar(64), ALTER COLUMN invoice_no TYPE varchar(64);
                        CREATE INDEX "IX_shipment_items_po_no" ON shipment_items(po_no);
                        """);
                }
                return f;
            }
            catch
            {
                await f.DisposeAsync();
                throw;
            }
        }
        public async ValueTask DisposeAsync()
        {
            await Db.DisposeAsync();
            await using var admin = new NpgsqlConnection(AdminConnection);
            await admin.OpenAsync();
            await admin.ExecuteAsync($"DROP DATABASE {Database}");
        }
    }

    private sealed class HttpHost(WebApplication app, HttpClient client) : IAsyncDisposable
    {
        public HttpClient Client => client;
        public static async Task<HttpHost> Start(string connection)
        {
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing", Args = [] });
            builder.Configuration.Sources.Clear();
            builder.Configuration.AddInMemoryCollection();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Services.AddSingleton<ISqlConnectionFactory>(new SqlConnectionFactory(connection));
            builder.Services.AddControllers().AddApplicationPart(typeof(ShipmentsController).Assembly);
            var app = builder.Build();
            // Real Kestrel/controller/JSON/transaction checks, not a production
            // authentication test. Existing API permission tests cover that layer.
            app.MapControllers();
            await app.StartAsync();
            return new(app, new HttpClient { BaseAddress = new Uri(app.Urls.Single()) });
        }
        public async ValueTask DisposeAsync()
        {
            client.Dispose();
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }

    public sealed class ShipmentTextFactAttribute : FactAttribute
    {
        public ShipmentTextFactAttribute()
        {
            if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ConnectionVariable)))
                Skip = "Requires explicit isolated loopback SHIPMENT_TEXT_TEST_CONNECTION";
        }
    }
    public sealed class ShipmentTextTheoryAttribute : TheoryAttribute
    {
        public ShipmentTextTheoryAttribute()
        {
            if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ConnectionVariable)))
                Skip = "Requires explicit isolated loopback SHIPMENT_TEXT_TEST_CONNECTION";
        }
    }
}
