using Dapper;
using IndoShipping.Api.Features.Bootstrap;
using Npgsql;
using Xunit;

namespace IndoShipping.Api.Tests;

public class PurchasePricePrecisionTests
{
    [Fact]
    public async Task Legacy_price_column_is_widened_without_changing_values_and_retains_eight_decimals()
    {
        var cs = Environment.GetEnvironmentVariable("SUPPLIER_SYNC_TEST_CONNECTION");
        if (string.IsNullOrWhiteSpace(cs)) return;
        await using var db = new NpgsqlConnection(cs);
        await db.OpenAsync();
        // Session-local table shadows permanent tables; no business data is touched.
        await db.ExecuteAsync("CREATE TEMP TABLE po_items(id int, price numeric(18,4)); INSERT INTO po_items VALUES(1, 99999999999999.1234)");
        await db.ExecuteAsync(PurchasePricePrecision.SchemaSql);
        await db.ExecuteAsync(PurchasePricePrecision.SchemaSql);
        Assert.Equal(99999999999999.1234m, await db.ExecuteScalarAsync<decimal>("SELECT price FROM po_items WHERE id=1"));
        foreach (var price in new[] { 0.00529m, 0.12345678m, 0.00000001m, 0m })
        {
            await db.ExecuteAsync("INSERT INTO po_items VALUES(2,@price)", new { price });
            Assert.Equal(price, await db.ExecuteScalarAsync<decimal>("SELECT price FROM po_items WHERE id=2"));
            await db.ExecuteAsync("UPDATE po_items SET price=@price WHERE id=2", new { price = price + 0.00000001m });
            Assert.Equal(price + 0.00000001m, await db.ExecuteScalarAsync<decimal>("SELECT price FROM po_items WHERE id=2"));
            await db.ExecuteAsync("DELETE FROM po_items WHERE id=2");
        }
        await db.ExecuteAsync("INSERT INTO po_items VALUES(3,0.00529)");
        Assert.Equal(1058m, await db.ExecuteScalarAsync<decimal>("SELECT ROUND(price*200000,2) FROM po_items WHERE id=3"));
    }

    [Fact]
    public async Task Existing_higher_precision_is_not_narrowed()
    {
        var cs = Environment.GetEnvironmentVariable("SUPPLIER_SYNC_TEST_CONNECTION");
        if (string.IsNullOrWhiteSpace(cs)) return;
        await using var db = new NpgsqlConnection(cs);
        await db.OpenAsync();
        await db.ExecuteAsync("CREATE TEMP TABLE po_items(price numeric(24,10)); INSERT INTO po_items VALUES(0.1234567891)");
        await db.ExecuteAsync(PurchasePricePrecision.SchemaSql);
        Assert.Equal(0.1234567891m, await db.ExecuteScalarAsync<decimal>("SELECT price FROM po_items"));
    }
}
