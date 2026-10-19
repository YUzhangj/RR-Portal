using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace VoyagePlex.Api.Services;

public static class WarehouseTripRules
{
    public const decimal YutaiMaximumCbm = 35m; // 裕泰仓已确认的每车体积上限。
    private const decimal VolumeTolerance = 0.000000001m; // 仅容忍数值序列化误差，不放宽业务上限。

    public static List<(string GroupKey, JsonObject Payload)> Split(JsonObject stored)
    {
        var plan = stored["warehouse_trip_plan"] as JsonObject;
        if (plan?["confirmed"]?.ToString().ToLowerInvariant() != "true")
            throw new InvalidOperationException("请在交仓预览中确认各车货物和吨车");
        var trips = plan["trips"] as JsonArray ?? [];
        var cargo = stored["items"] as JsonArray ?? [];
        if (trips.Count == 0 || cargo.Count == 0) throw new InvalidOperationException("分车安排或货物不能为空");
        var counts = new int[cargo.Count];
        var totals = new decimal[cargo.Count, 4];
        var keys = new HashSet<string>(StringComparer.Ordinal);
        var packingTrips = new Dictionary<string, int>(StringComparer.Ordinal);
        var result = new List<(string, JsonObject)>();
        foreach (var (node, tripIndex) in trips.Select((node, index) => (node, index)))
        {
            var trip = node as JsonObject ?? throw new InvalidOperationException("分车安排格式无效");
            var key = trip["key"]?.ToString() ?? "";
            var warehouse = trip["warehouse"]?.ToString().Trim() ?? "";
            if (key.Length == 0 || !keys.Add(key)) throw new InvalidOperationException("分车编号缺失或重复");
            if (warehouse.Length == 0 || warehouse.Contains("待确认")) throw new InvalidOperationException($"第{tripIndex + 1}车请确认交仓仓库");
            var rows = trip["allocations"] as JsonArray ?? [];
            if (rows.Count == 0) throw new InvalidOperationException($"第{tripIndex + 1}车没有货物，请删除空车");
            var selected = new JsonArray();
            var packingVolumes = new Dictionary<string, decimal>(StringComparer.Ordinal);
            decimal volume = 0;
            foreach (var row in rows.OfType<JsonObject>())
            {
                if (!int.TryParse(row["item_index"]?.ToString(), out var index) || index < 0 || index >= cargo.Count)
                    throw new InvalidOperationException("分车货物来源无效，请重新核对");
                var source = cargo[index] as JsonObject ?? throw new InvalidOperationException("货物资料格式无效");
                var copy = source.DeepClone().AsObject();
                foreach (var (field, fieldIndex) in new[] { ("quantity", 0), ("pieces", 1), ("volume", 2) })
                {
                    var value = Number(row[field]);
                    if (fieldIndex < 2 && value != decimal.Truncate(value)) throw new InvalidOperationException("分车数量、件数必须是整数");
                    totals[index, fieldIndex] += value;
                    copy[field] = value;
                }
                if (!string.IsNullOrWhiteSpace(source["pallet_count"]?.ToString()) || !string.IsNullOrWhiteSpace(row["pallet_count"]?.ToString()))
                {
                    var pallets = Number(row["pallet_count"]);
                    if (pallets != decimal.Truncate(pallets)) throw new InvalidOperationException("卡板数必须是非负整数");
                    totals[index, 3] += pallets;
                    copy["pallet_count"] = pallets;
                }
                else copy["pallet_count"] = "";
                copy["cbm"] = copy["volume"]!.DeepClone();
                counts[index]++;
                var packing = source["packing_group"]?.ToString() ?? "";
                var rowVolume = Number(copy["volume"]);
                if (packing.Length > 0)
                {
                    var packingKey = $"{source["source_file"]}\u001f{packing}";
                    if (counts[index] > 1 || packingTrips.TryGetValue(packingKey, out var assigned) && assigned != tripIndex)
                        throw new InvalidOperationException("同一已确认混装组需整组分配到同一车，暂不支持拆行");
                    packingTrips[packingKey] = tripIndex;
                    if (packingVolumes.TryGetValue(packingKey, out var shared) && shared != rowVolume)
                        throw new InvalidOperationException("混装组共享体积不一致，请核对");
                    if (!packingVolumes.ContainsKey(packingKey)) { packingVolumes[packingKey] = rowVolume; volume += rowVolume; }
                }
                else volume += rowVolume;
                selected.Add(copy);
            }
            if (selected.Count == 0 || volume <= 0) throw new InvalidOperationException($"第{tripIndex + 1}车体积缺失或无效");
            if (warehouse.Contains("裕泰") && volume > YutaiMaximumCbm + VolumeTolerance)
                throw new InvalidOperationException($"第{tripIndex + 1}车超过裕泰仓35 CBM上限，请调整分车");
            var vehicle = trip["vehicle_type"]?.ToString().Trim() ?? "";
            if (vehicle.Length > 0 && !Regex.IsMatch(vehicle, @"^(?:[1-9]\d*\s*[*x×]\s*)?(?:[1-9]\d*(?:\.\d+)?)\s*(?:T|吨(?:车)?)$", RegexOptions.IgnoreCase))
                throw new InvalidOperationException($"第{tripIndex + 1}车吨车格式无效，例如1*3T");
            if (vehicle.Length == 0 && volume > 50m) throw new InvalidOperationException($"第{tripIndex + 1}车体积超出推荐范围，请人工填写吨车");
            var payload = stored.DeepClone().AsObject();
            payload.Remove("warehouse_trip_plan");
            payload["items"] = selected;
            var fields = payload["fields"] as JsonObject ?? new JsonObject();
            fields["shipment_mode"] = "Warehouse";
            fields["warehouse"] = warehouse;
            fields["container_type"] = vehicle;
            fields["vehicle_type"] = vehicle;
            fields["truck_type_source"] = vehicle.Length > 0 ? "manual" : "recommended";
            payload["fields"] = fields;
            payload["warehouse_groups"] = new JsonArray(new JsonObject { ["warehouse"] = warehouse, ["items"] = selected.DeepClone(), ["references"] = new JsonArray(), ["source_files"] = new JsonArray() });
            result.AddRange(CargoNotificationRules.Split($"truck:{key}", payload));
        }
        for (var index = 0; index < cargo.Count; index++)
        {
            if (counts[index] == 0) throw new InvalidOperationException($"第{index + 1}条货物尚未分车");
            if (!string.IsNullOrWhiteSpace(cargo[index]?["pallet_count"]?.ToString()) && totals[index, 3] != Number(cargo[index]?["pallet_count"]))
                throw new InvalidOperationException($"第{index + 1}条货物分车后的卡板合计与原资料不一致");
            foreach (var (field, fieldIndex) in new[] { ("quantity", 0), ("pieces", 1), ("volume", 2) })
            {
                var original = cargo[index]?[field] ?? (field == "volume" ? cargo[index]?["cbm"] : null);
                if (Math.Abs(totals[index, fieldIndex] - Number(original)) > VolumeTolerance)
                    throw new InvalidOperationException($"第{index + 1}条货物分车后的数量、件数、体积合计与原资料不一致");
            }
        }
        return result;
    }

    private static decimal Number(JsonNode? value)
    {
        if (!decimal.TryParse(value?.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || number < 0)
            throw new InvalidOperationException("分车数量、件数和体积必须填写有效非负数");
        return number;
    }
}
