using System.Text.Json;
using Dapper;
using IndoShipping.Api.Controllers;
using IndoShipping.Api.Features.Bootstrap;
using IndoShipping.Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;
using Npgsql;
using Xunit;

namespace IndoShipping.Api.Tests;

public class ScheduleLineIntegrationTests
{
    [Fact]
    public async Task Existing_history_and_new_upload_use_the_same_line_matching_without_changing_manual_flags()
    {
        var connection = Environment.GetEnvironmentVariable("SUPPLIER_SYNC_TEST_CONNECTION");
        if (string.IsNullOrWhiteSpace(connection)) return;
        var schema = "schedule_line_test_" + Guid.NewGuid().ToString("N");
        var options = new NpgsqlConnectionStringBuilder(connection) { SearchPath = schema };
        await using var db = new NpgsqlConnection(options.ConnectionString);
        await db.OpenAsync();
        await db.ExecuteAsync($"CREATE SCHEMA {schema}");
        try
        {
            await db.ExecuteAsync("""
                CREATE TABLE schedules(id serial PRIMARY KEY, week_label text UNIQUE, upload_date timestamp,
                    raw_rows jsonb, diff_from_prev jsonb);
                CREATE TABLE settings(key text PRIMARY KEY, value text);
                CREATE TABLE materials(id int, product_code text, item_no text, name_zh text, category text,
                    supplier text, usage_qty numeric, active boolean);
                CREATE TABLE products(code text, name text, moldings jsonb, active boolean);
                INSERT INTO settings VALUES ('schedule_placed_manual','["MA|47712A"]');
                """);
            await db.ExecuteAsync(MaterialTrackingHistory.SchemaSql);
            var controller = new SchedulesController(new SqlConnectionFactory(options.ConnectionString));
            const string old = """{"source":"KIK","customer":"TOMY","code":"47712A","orderNo":"MA","qty":100,"eta":"2026-11-01"}""";
            const string added = """{"source":"KIK","customer":"TOMY","code":"47712A","orderNo":"MA","qty":200,"eta":"2026-12-01"}""";
            await db.ExecuteAsync("""
                INSERT INTO schedules(week_label,upload_date,raw_rows,diff_from_prev)
                VALUES ('2026-W42','2026-10-12',CAST(@old AS jsonb),'{}'),
                       ('26-10-19','2026-10-19',CAST(@current AS jsonb),'{}');
                """, new { old = $"[{old}]", current = $"[{old},{added}]" });
            var beforeRaw = await db.ExecuteScalarAsync<string>("SELECT raw_rows::text FROM schedules WHERE id=2");
            var view = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(await controller.Get(2)).Value);
            using var rows = JsonDocument.Parse(view.GetProperty("raw_rows").GetString()!);
            using var diff = JsonDocument.Parse(view.GetProperty("diff_from_prev").GetString()!);
            Assert.Equal(1, diff.RootElement.GetProperty("added").GetArrayLength());
            Assert.True(rows.RootElement[0].GetProperty("_legacyPlacedEligible").GetBoolean());
            Assert.False(rows.RootElement[1].GetProperty("_legacyPlacedEligible").GetBoolean());
            var oldId = rows.RootElement[0].GetProperty("_scheduleLineId").GetString();
            var newId = rows.RootElement[1].GetProperty("_scheduleLineId").GetString();
            Assert.NotEqual(oldId, newId);
            Assert.Equal(beforeRaw, await db.ExecuteScalarAsync<string>("SELECT raw_rows::text FROM schedules WHERE id=2"));
            Assert.Equal("[\"MA|47712A\"]", await db.ExecuteScalarAsync<string>("SELECT value FROM settings WHERE key='schedule_placed_manual'"));

            // Re-upload with rows reversed: no deduplication, old/new identities remain stable.
            Assert.IsType<OkObjectResult>(await controller.Create(new()
            {
                week_label = "26-10-19", upload_date = new DateTime(2026, 10, 19),
                raw_rows = JsonSerializer.Deserialize<JsonElement>($"[{added},{old}]"),
            }));
            view = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(await controller.Get(2)).Value);
            using var reordered = JsonDocument.Parse(view.GetProperty("raw_rows").GetString()!);
            Assert.Equal(newId, reordered.RootElement[0].GetProperty("_scheduleLineId").GetString());
            Assert.Equal(oldId, reordered.RootElement[1].GetProperty("_scheduleLineId").GetString());
            using var storedDiff = JsonDocument.Parse((await db.ExecuteScalarAsync<string>("SELECT diff_from_prev::text FROM schedules WHERE id=2"))!);
            Assert.Equal(1, storedDiff.RootElement.GetProperty("added").GetArrayLength());
        }
        finally { await db.ExecuteAsync($"DROP SCHEMA {schema} CASCADE"); }
    }
}
