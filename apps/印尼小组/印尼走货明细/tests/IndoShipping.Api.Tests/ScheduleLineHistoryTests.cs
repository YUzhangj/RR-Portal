using System.Text.Json;
using System.Text.Json.Nodes;
using IndoShipping.Api.Features.Schedules;
using Xunit;

namespace IndoShipping.Api.Tests;

public class ScheduleLineHistoryTests
{
    static JsonObject Row(int qty = 100, string eta = "2026-11-01", string orderDate = "2026-09-01") => new()
    {
        ["source"] = "KIK", ["customer"] = "TOMY", ["code"] = "47712A", ["orderNo"] = "MA",
        ["productName"] = "绿色拖拉机", ["qty"] = qty, ["eta"] = eta, ["orderDate"] = orderDate,
        ["unitPrice"] = 1.5,
    };
    static ScheduleLineHistory.Snapshot Snapshot(int id, string label, params JsonObject[] rows) =>
        new(id, label, new DateTime(2026, 10, 19), JsonSerializer.Serialize(rows));
    static string Id(JsonObject r) => ScheduleLineHistory.LineKey(r);
    static bool Eligible(JsonObject r) => r["_legacyPlacedEligible"]!.GetValue<bool>();

    [Fact]
    public void New_duplicate_is_added_and_does_not_inherit_old_flags()
    {
        var views = ScheduleLineHistory.Build([
            Snapshot(1, "2026-W42", Row()), Snapshot(2, "26-10-19", Row(), Row(200, "2026-12-01"))]);
        var current = views[1];
        Assert.Equal(Id(views[0].Rows[0]), Id(current.Rows[0]));
        Assert.NotEqual(Id(current.Rows[0]), Id(current.Rows[1]));
        Assert.True(Eligible(current.Rows[0]));
        Assert.False(Eligible(current.Rows[1]));
        Assert.False(current.Rows[1]["_legacyProductionEligible"]!.GetValue<bool>());
        Assert.Same(current.Rows[1], Assert.Single(current.Diff.added));
        Assert.Empty(current.Diff.changed);
        Assert.Empty(current.Diff.removed);
    }

    [Fact]
    public void Exact_match_is_reserved_even_when_new_row_comes_first()
    {
        var views = ScheduleLineHistory.Build([
            Snapshot(1, "2026-W42", Row()), Snapshot(2, "26-10-19", Row(200), Row())]);
        Assert.Equal(Id(views[0].Rows[0]), Id(views[1].Rows[1]));
        Assert.Same(views[1].Rows[0], Assert.Single(views[1].Diff.added));
        Assert.False(Eligible(views[1].Rows[0]));
    }

    [Fact]
    public void Identical_duplicate_occurrences_are_not_collapsed()
    {
        var views = ScheduleLineHistory.Build([
            Snapshot(1, "2026-W42", Row()), Snapshot(2, "26-10-19", Row(), Row()),
            Snapshot(3, "2026-W44", Row(), Row())]);
        Assert.Single(views[1].Diff.added);
        Assert.Equal(2, views[1].Rows.Select(Id).Distinct().Count());
        Assert.Empty(views[2].Diff.added);
        Assert.Equal(views[1].Rows.Select(Id), views[2].Rows.Select(Id));
    }

    [Fact]
    public void Removing_one_duplicate_is_detected()
    {
        var views = ScheduleLineHistory.Build([
            Snapshot(1, "2026-W42", Row(), Row(200)), Snapshot(2, "26-10-19", Row(200))]);
        Assert.Equal(Id(views[0].Rows[0]), Id(Assert.Single(views[1].Diff.removed)));
        Assert.Equal(Id(views[0].Rows[1]), Id(views[1].Rows[0]));
    }

    [Fact]
    public void Unique_quantity_and_eta_edit_retains_line_identity()
    {
        var views = ScheduleLineHistory.Build([
            Snapshot(1, "2026-W42", Row()), Snapshot(2, "26-10-19", Row(200, "2026-12-01"))]);
        Assert.Equal(Id(views[0].Rows[0]), Id(views[1].Rows[0]));
        Assert.Single(views[1].Diff.changed);
        Assert.Empty(views[1].Diff.added);
        Assert.True(Eligible(views[1].Rows[0]));
    }

    [Theory]
    [InlineData("customerPO", "new-po")]
    [InlineData("orderDate", "2026-10-19")]
    [InlineData("source", "RRM")]
    [InlineData("customer", "OTHER")]
    [InlineData("country", "美国")]
    [InlineData("endCustomer", "NEW CUSTOMER")]
    public void Different_order_identity_does_not_inherit_status(string field, string value)
    {
        var added = Row(); added[field] = value;
        var views = ScheduleLineHistory.Build([
            Snapshot(1, "2026-W42", Row()), Snapshot(2, "26-10-19", Row(), added)]);
        Assert.Single(views[1].Diff.added);
        Assert.False(Eligible(views[1].Rows[1]));
    }

    [Fact]
    public void Ambiguous_legacy_duplicates_are_not_all_marked_as_placed()
    {
        var view = Assert.Single(ScheduleLineHistory.Build([Snapshot(1, "2026-W42", Row(), Row(200))]));
        Assert.All(view.Rows, r => Assert.False(Eligible(r)));
    }

    [Fact]
    public void Ambiguous_changed_duplicates_are_not_guessed()
    {
        var views = ScheduleLineHistory.Build([
            Snapshot(1, "2026-W42", Row()), Snapshot(2, "26-10-19", Row(200), Row(300))]);
        Assert.Equal(2, views[1].Diff.added.Count);
        Assert.Single(views[1].Diff.removed);
        Assert.All(views[1].Rows, r => Assert.False(Eligible(r)));
    }

    [Fact]
    public void Mixed_labels_sort_by_period_not_lexically_or_upload_order()
    {
        var views = ScheduleLineHistory.Build([
            Snapshot(2, "26-10-19", Row()), Snapshot(1, "2026-W42", Row())]);
        Assert.Equal(1, views[0].Snapshot.Id);
        Assert.Empty(views[1].Diff.added);
        Assert.Equal(Id(views[0].Rows[0]), Id(views[1].Rows[0]));
    }

    [Fact]
    public void Removed_then_reintroduced_order_gets_a_new_identity()
    {
        var views = ScheduleLineHistory.Build([
            Snapshot(1, "2026-W42", Row()), Snapshot(2, "2026-W43"), Snapshot(3, "2026-W44", Row())]);
        Assert.NotEqual(Id(views[0].Rows[0]), Id(views[2].Rows[0]));
        Assert.False(Eligible(views[2].Rows[0]));
    }
}
