using System.Text.Json.Nodes;
namespace VoyagePlex.Api.Services;
public static class WarehouseSoRules
{
    public static List<(string GroupKey, JsonObject Payload)> Split(JsonObject stored)
    {
        var result = new List<(string, JsonObject)>();
        var cargo = stored["items"]?.AsArray() ?? [];
        var assigned = new HashSet<int>();
        foreach (var group in stored["warehouse_groups"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            var so = group["so_number"]?.ToString() ?? "";
            if (string.IsNullOrWhiteSpace(so) || so.Contains(',')) throw new InvalidOperationException("交仓分组缺少明确SO号，请核对货物与SO归属");
            var selected = new JsonArray();
            foreach (var item in group["items"]?.AsArray() ?? [])
            {
                var index = Enumerable.Range(0, cargo.Count).FirstOrDefault(i => !assigned.Contains(i) &&
                    cargo[i]?["source_file"]?.ToString() == item?["source_file"]?.ToString() &&
                    cargo[i]?["source_row"]?.ToString() == item?["source_row"]?.ToString() &&
                    cargo[i]?["product_code"]?.ToString() == item?["product_code"]?.ToString(), -1);
                if (index < 0) throw new InvalidOperationException("交仓货物归属重复或不完整，请核对");
                assigned.Add(index); selected.Add(cargo[index]!.DeepClone());
            }
            if (selected.Count == 0) continue;
            var payload = stored.DeepClone().AsObject();
            payload["fields"]!["so_number"] = so;
            payload["so_numbers"] = new JsonArray(so);
            payload["items"] = selected;
            var copy = group.DeepClone().AsObject(); copy["items"] = selected.DeepClone();
            payload["warehouse_groups"] = new JsonArray(copy);
            result.Add(($"warehouse:{group["warehouse"]}:{so}", payload));
        }
        if (assigned.Count != cargo.Count) throw new InvalidOperationException("交仓货物尚未完整分配SO，不能确认");
        return result;
    }
}
