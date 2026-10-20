using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace IndoShipping.Api.Features.Schedules;

// A PO number is not a schedule-line ID (in particular, MA is reused).
// Match occurrences one-to-one, keeping exact old lines before pairing edits.
public static class ScheduleLineHistory
{
    public sealed record Snapshot(int Id, string? Label, DateTime? Uploaded, string? Raw);
    public sealed record Difference(List<JsonObject> added, List<JsonObject> removed, List<object> changed);
    public sealed record View(Snapshot Snapshot, List<JsonObject> Rows, Difference Diff);
    static readonly string[] Identity = ["source", "customer", "code", "orderNo", "customerPO", "orderDate", "country", "endCustomer"];
    static readonly string[] Significant = ["qty", "eta", "productName", "unitPrice"];

    public static string Field(JsonObject row, string key) => row[key]?.ToString().Trim() ?? "";
    public static string LegacyKey(JsonObject row) => $"{Field(row, "orderNo")}|{Field(row, "code")}";
    public static string LineKey(JsonObject row) => Field(row, "_scheduleLineId");
    static string Signature(JsonObject row, IEnumerable<string> fields) =>
        JsonSerializer.Serialize(fields.Select(k => Field(row, k)));
    static bool Modified(JsonObject a, JsonObject b) => Significant.Any(k =>
        k is "qty" or "unitPrice"
            ? Number(a, k) != Number(b, k)
            : Field(a, k) != Field(b, k));
    static decimal Number(JsonObject row, string key) => decimal.TryParse(Field(row, key),
        NumberStyles.Any, CultureInfo.InvariantCulture, out var n) ? n : 0;

    public static DateTime Period(Snapshot snapshot)
    {
        var label = snapshot.Label?.Trim() ?? "";
        var week = Regex.Match(label, @"^(\d{4})-W(\d{1,2})$", RegexOptions.IgnoreCase);
        if (week.Success && int.TryParse(week.Groups[1].Value, out var year) && year is >= 1 and <= 9999 &&
            int.TryParse(week.Groups[2].Value, out var w) && w >= 1 && w <= ISOWeek.GetWeeksInYear(year))
            return ISOWeek.ToDateTime(year, w, DayOfWeek.Monday);
        if (Regex.IsMatch(label, @"^\d{2}-\d{2}-\d{2}$")) label = "20" + label;
        if (DateTime.TryParseExact(label, ["yyyy-MM-dd", "yyyy/M/d", "yyyy-M-d"],
            CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)) return date;
        return snapshot.Uploaded?.Date ?? DateTime.MinValue;
    }

    public static List<View> Build(IEnumerable<Snapshot> snapshots)
    {
        var views = new List<View>();
        var previous = new List<JsonObject>();
        // Old broad flags can belong to the first occurrence only, never every future row.
        var legacyOwners = new Dictionary<string, string>();
        var productionOwners = new Dictionary<string, HashSet<string>>();
        foreach (var snapshot in snapshots.OrderBy(Period).ThenBy(x => x.Id))
        {
            var rows = Parse(snapshot.Raw);
            var remaining = new HashSet<JsonObject>(previous, ReferenceEqualityComparer.Instance);
            var pairs = new Dictionary<JsonObject, JsonObject>(ReferenceEqualityComparer.Instance);
            var oldGroups = previous.GroupBy(p => Signature(p, Identity)).ToDictionary(g => g.Key, g => g.ToList());
            foreach (var group in rows.GroupBy(r => Signature(r, Identity)))
            {
                var old = oldGroups.GetValueOrDefault(group.Key) ?? [];
                // Reserve exact matches first; a new row may appear before the old one.
                foreach (var row in group)
                {
                    var match = old.FirstOrDefault(p => remaining.Contains(p) && !Modified(p, row));
                    if (match is null) continue;
                    pairs[row] = match;
                    remaining.Remove(match);
                }
                var unmatched = group.Where(r => !pairs.ContainsKey(r)).ToList();
                var available = old.Where(remaining.Contains).ToList();
                // Only an unambiguous one-to-one remainder is an edit. Never guess among duplicates.
                if (unmatched.Count == 1 && available.Count == 1)
                {
                    pairs[unmatched[0]] = available[0];
                    remaining.Remove(available[0]);
                }
            }
            var added = new List<JsonObject>();
            var changed = new List<object>();
            var occurrences = new Dictionary<string, int>();
            foreach (var row in rows)
            {
                var signature = Signature(row, Identity.Concat(Significant));
                var occurrence = occurrences.GetValueOrDefault(signature);
                occurrences[signature] = occurrence + 1;
                if (pairs.TryGetValue(row, out var old))
                {
                    row["_scheduleLineId"] = LineKey(old);
                    if (Modified(old, row)) changed.Add(new { from = old, to = row });
                }
                else
                {
                    var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature)))[..24];
                    row["_scheduleLineId"] = $"line:{snapshot.Id}:{hash}:{occurrence}";
                    added.Add(row);
                }
            }
            foreach (var group in rows.GroupBy(LegacyKey))
                if (!legacyOwners.ContainsKey(group.Key))
                    legacyOwners[group.Key] = group.Count() == 1 ? LineKey(group.First()) : "";
            foreach (var group in rows.GroupBy(r => Field(r, "orderNo")))
                if (!productionOwners.ContainsKey(group.Key))
                    productionOwners[group.Key] = group.Select(LineKey).ToHashSet();
            foreach (var row in rows)
            {
                row["_legacyPlacedEligible"] = legacyOwners[LegacyKey(row)] == LineKey(row);
                row["_legacyProductionEligible"] = productionOwners[Field(row, "orderNo")].Contains(LineKey(row));
            }
            views.Add(new(snapshot, rows, new(added, previous.Where(remaining.Contains).ToList(), changed)));
            previous = rows;
        }
        return views;
    }

    public static List<JsonObject> Parse(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return [];
        try { return (JsonNode.Parse(raw) as JsonArray)?.OfType<JsonObject>().Select(r => (JsonObject)r.DeepClone()).ToList() ?? []; }
        catch (JsonException) { return []; }
    }
}
