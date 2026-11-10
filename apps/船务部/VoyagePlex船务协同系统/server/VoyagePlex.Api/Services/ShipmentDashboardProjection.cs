using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using VoyagePlex.Api.Entities;

namespace VoyagePlex.Api.Services;

// Home-only accounts receive the fields actually rendered by the dashboard,
// plus anomaly booleans. Raw cargo, export details and source mail stay private.
public static class ShipmentDashboardProjection
{
    public static object From(ShipmentTask task)
    {
        JsonArray items;
        try { items = JsonNode.Parse(task.ItemsJson) as JsonArray ?? new(); }
        catch (JsonException) { items = new(); }
        var inspectionFailed = items.OfType<JsonObject>().Any(item =>
            Regex.IsMatch(Text(item["inspection_result"]) is { Length: > 0 } inspection ? inspection : Text(item["qc_result"]),
                "不通过|未通过|fail|reject", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant));
        var inventoryShortage = items.OfType<JsonObject>().Any(item =>
            item.ContainsKey("inventory_quantity") && item["inventory_quantity"]?.ToString() != "" &&
            Number(item["inventory_quantity"]) < Number(item["quantity"]));
        return new
        {
            task.Id, task.Customer, task.SoNumber, task.ContainerType, task.PlannedShipDate, task.Status,
            CreatedAt = UtcDateTime.Normalize(task.CreatedAt), UpdatedAt = UtcDateTime.Normalize(task.UpdatedAt),
            InspectionFailed = inspectionFailed, InventoryShortage = inventoryShortage,
        };
    }

    private static string Text(JsonNode? value) => value?.ToString() ?? "";
    private static double Number(JsonNode? value)
    {
        var text = Text(value).Trim();
        if (text.Length == 0) return 0;
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ? number : double.NaN;
    }
}
