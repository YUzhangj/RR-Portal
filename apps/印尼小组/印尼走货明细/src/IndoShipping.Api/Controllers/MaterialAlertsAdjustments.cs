using System.Text.Json;
using Dapper;
using IndoShipping.Api.Auditing;
using Microsoft.AspNetCore.Mvc;

namespace IndoShipping.Api.Controllers;

public partial class MaterialAlertsController
{
    private const string AdjustmentKey = "material_tracking_order_adjustments";
    private static readonly HashSet<string> ManualStatuses = ["未下单", "已下单", "欠采购", "未排产", "已排产", "欠排产",
        "待入库", "部分入库", "已入库", "待出库", "部分出库", "已出库", "部分已送完", "已送完"];

    public sealed class AdjustmentBody
    {
        public string order_key { get; set; } = "";
        public long expected_version { get; set; }
        public long expected_revision_id { get; set; }
        public decimal expected_source_required { get; set; }
        public decimal expected_source_ordered { get; set; }
        public decimal expected_source_received { get; set; }
        public decimal expected_source_outbound { get; set; }
        public decimal expected_source_manual { get; set; }
        public bool reset { get; set; }
        public decimal? required_qty { get; set; }
        public decimal? ordered_qty { get; set; }
        public decimal? received_qty { get; set; }
        public decimal? outbound_qty { get; set; }
        public decimal? manual_qty { get; set; }
        public string? status { get; set; }
        public string note { get; set; } = "";
    }

    public sealed class TrackingAdjustment
    {
        public long version { get; set; }
        public bool active { get; set; }
        // Store a correction relative to source demand. Later extra demand must not
        // disappear behind an old fixed override or inherit a blanket completion.
        public decimal? required_delta { get; set; }
        public decimal? ordered_qty { get; set; }
        public decimal? received_qty { get; set; }
        public decimal? outbound_qty { get; set; }
        public decimal? manual_qty { get; set; }
        // Quantity snapshots plus their source baselines retain the correction as
        // actual allocations change. Null baselines support older fixed records.
        public decimal? ordered_base { get; set; }
        public decimal? received_base { get; set; }
        public decimal? outbound_base { get; set; }
        public decimal? manual_base { get; set; }
        public string? status { get; set; }
        public string note { get; set; } = "";
        public string updated_by { get; set; } = "";
        public DateTime updated_at { get; set; }
    }

    private static Dictionary<string, TrackingAdjustment> ReadAdjustments(string? json) =>
        string.IsNullOrWhiteSpace(json) ? new() : JsonSerializer.Deserialize<Dictionary<string, TrackingAdjustment>>(json) ?? new();

    private static decimal AdjustedQuantity(decimal source, decimal? quantity, decimal? baseline) =>
        quantity.HasValue ? Math.Max(0, source + quantity.Value - (baseline ?? source)) : source;

    private static (decimal? quantity, decimal? baseline) PreserveOrRebaseQuantity(bool active,
        decimal source, decimal effective, decimal? submitted, decimal? previous, decimal? baseline) =>
        active && previous.HasValue && submitted.HasValue && submitted.Value == effective
            ? (previous, baseline) : (submitted, source);

    [HttpGet("adjustment-history")]
    public async Task<IActionResult> AdjustmentHistory([FromQuery] string order_key, [FromQuery] int page = 1)
    {
        if (string.IsNullOrWhiteSpace(order_key) || order_key.Length > 4000 || page < 1 || page > 1_000_000)
            return BadRequest(new { message = "订单标识或页码无效" });
        using var c = factory.Create();
        const string filter = "FROM audit_logs WHERE module='material-alerts' AND entity_type='tracking-order' AND entity_id=@order_key AND action IN ('adjust-tracking','reset-adjustment')";
        var total = await c.ExecuteScalarAsync<long>("SELECT COUNT(*) " + filter, new { order_key });
        var rows = await c.QueryAsync<AdjustmentHistoryRow>(
            "SELECT id, occurred_at, username, action, details::text AS details " + filter +
            " ORDER BY occurred_at DESC, id DESC LIMIT 20 OFFSET @offset", new { order_key, offset = (page - 1) * 20 });
        return Ok(new { total, items = rows.Select(r => new { r.id, r.occurred_at, r.username, r.action,
            details = JsonSerializer.Deserialize<JsonElement>(r.details) }) });
    }

    private sealed class AdjustmentHistoryRow
    {
        public long id { get; set; }
        public DateTime occurred_at { get; set; }
        public string username { get; set; } = "";
        public string action { get; set; } = "";
        public string details { get; set; } = "{}";
    }

    [HttpPut("adjustment")]
    public async Task<IActionResult> SaveAdjustment([FromBody] AdjustmentBody body)
    {
        var quantities = new[] { body.required_qty, body.ordered_qty, body.received_qty, body.outbound_qty, body.manual_qty };
        if (string.IsNullOrWhiteSpace(body.order_key) || body.order_key.Length > 4000
            || quantities.Any(q => q is < 0 or > 1_000_000_000_000m)
            || body.expected_version < 0 || (body.note?.Length ?? 0) > 500)
            return BadRequest(new { message = "数量须为 0 至 1 万亿，备注最多 500 字，订单标识不能为空" });
        var status = body.reset || string.IsNullOrWhiteSpace(body.status) ? null : body.status.Trim();
        if (status != null && !ManualStatuses.Contains(status)) return BadRequest(new { message = "不支持的追踪状态" });
        if (string.IsNullOrWhiteSpace(body.note)) return BadRequest(new { message = "请填写手动调整或恢复原因" });

        using var c = factory.Create(); c.Open();
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("INSERT INTO settings(key,value) VALUES(@AdjustmentKey,'{}') ON CONFLICT(key) DO NOTHING", new { AdjustmentKey }, tx);
        var stored = ReadAdjustments(await c.ExecuteScalarAsync<string>(
            "SELECT value FROM settings WHERE key=@AdjustmentKey FOR UPDATE", new { AdjustmentKey }, tx));
        stored.TryGetValue(body.order_key, out var before);
        if ((before?.version ?? 0) != body.expected_version) return Conflict(new { message = "该订单追踪已被修改，请刷新后重试" });
        var alerts = await BuildAlerts();
        var item = alerts?.items.FirstOrDefault(i => i.order_details.Any(d => d.key == body.order_key));
        var detail = item?.order_details.Single(d => d.key == body.order_key);
        if (detail == null || string.IsNullOrWhiteSpace(detail.order_no)) return NotFound(new { message = "对应订单已不存在或缺少订单号，请刷新核对" });
        if (alerts!.latest_revision_id != body.expected_revision_id || detail.source_required_qty != body.expected_source_required)
            return Conflict(new { message = "排期或需求已变化，请刷新后重新核对" });
        if (detail.source_ordered_qty != body.expected_source_ordered || detail.source_received_qty != body.expected_source_received
            || detail.source_outbound_qty != body.expected_source_outbound || detail.source_manual_qty != body.expected_source_manual)
            return Conflict(new { message = "采购、入出库或送完确认已变化，请刷新后重新核对" });
        if (item!.tracking_type == "purchase" ? status is "未排产" or "已排产" or "欠排产" : status is "未下单" or "已下单" or "欠采购")
            return BadRequest(new { message = "状态与外购/生产类型不符" });
        var preserve = before?.active == true;
        decimal? requiredDelta = body.required_qty == null ? null
            : preserve && before!.required_delta.HasValue && body.required_qty.Value == detail.required_qty_exact
                ? before.required_delta : body.required_qty.Value - detail.source_required_qty;
        var required = Math.Max(0, detail.source_required_qty + (requiredDelta ?? 0));
        // A real transition confirms the current demand. Keeping an existing
        // completion label while editing its note must not confirm later demand.
        var confirmCompletion = status == "已送完" && (!preserve || before!.status != "已送完");
        var manual = confirmCompletion ? required : body.manual_qty;
        var unchangedPartial = preserve && status == "部分已送完" && before!.status == status
            && requiredDelta == before.required_delta && before.manual_qty.HasValue
            && body.manual_qty.HasValue && body.manual_qty.Value == detail.manual_qty_exact;
        if (status == "部分已送完" && !unchangedPartial && !(manual > 0 && manual < required))
            return BadRequest(new { message = "部分送完须填写大于 0 且小于需求的确认量" });
        var ordered = PreserveOrRebaseQuantity(preserve, detail.source_ordered_qty, detail.ordered_qty,
            body.ordered_qty, before?.ordered_qty, before?.ordered_base);
        var received = PreserveOrRebaseQuantity(preserve, detail.source_received_qty, detail.received_qty,
            body.received_qty, before?.received_qty, before?.received_base);
        var outbound = PreserveOrRebaseQuantity(preserve, detail.source_outbound_qty, detail.outbound_qty,
            body.outbound_qty, before?.outbound_qty, before?.outbound_base);
        var completed = PreserveOrRebaseQuantity(preserve && !confirmCompletion, detail.source_manual_qty, detail.manual_qty_exact,
            manual, before?.manual_qty, before?.manual_base);
        var after = new TrackingAdjustment {
            version = (before?.version ?? 0) + 1, active = !body.reset,
            required_delta = body.reset ? null : requiredDelta,
            ordered_qty = body.reset ? null : ordered.quantity, received_qty = body.reset ? null : received.quantity,
            outbound_qty = body.reset ? null : outbound.quantity, manual_qty = body.reset ? null : completed.quantity,
            ordered_base = body.reset ? detail.source_ordered_qty : ordered.baseline,
            received_base = body.reset ? detail.source_received_qty : received.baseline,
            outbound_base = body.reset ? detail.source_outbound_qty : outbound.baseline,
            manual_base = body.reset ? detail.source_manual_qty : completed.baseline,
            status = body.reset ? null : status, note = body.note!.Trim(),
            updated_by = User.Identity?.Name ?? "", updated_at = DateTime.UtcNow,
        };
        stored[body.order_key] = after;
        await c.ExecuteAsync("UPDATE settings SET value=@value WHERE key=@AdjustmentKey",
            new { value = JsonSerializer.Serialize(stored), AdjustmentKey }, tx);
        await this.WriteAsync(c, tx, "material-alerts", body.reset ? "reset-adjustment" : "adjust-tracking",
            "tracking-order", body.order_key, $"{(body.reset ? "恢复自动" : "手动调整")}物料追踪：{detail.order_no}", new {
                before, after, order_no = detail.order_no, item.product_code, item.material_name,
                source = new { required_qty = detail.source_required_qty, ordered_qty = detail.source_ordered_qty,
                    received_qty = detail.source_received_qty, outbound_qty = detail.source_outbound_qty, manual_qty = detail.source_manual_qty },
                previous = new { required_qty = detail.required_qty_exact, detail.ordered_qty, detail.received_qty,
                    detail.outbound_qty, manual_qty = detail.manual_qty_exact, detail.status },
                current = new { required_qty = Math.Max(0, detail.source_required_qty + (after.required_delta ?? 0)),
                    ordered_qty = AdjustedQuantity(detail.source_ordered_qty, after.ordered_qty, after.ordered_base),
                    received_qty = AdjustedQuantity(detail.source_received_qty, after.received_qty, after.received_base),
                    outbound_qty = AdjustedQuantity(detail.source_outbound_qty, after.outbound_qty, after.outbound_base),
                    manual_qty = AdjustedQuantity(detail.source_manual_qty, after.manual_qty, after.manual_base), status = after.status ?? "自动计算" },
            });
        tx.Commit();
        return Ok(new { ok = true, version = after.version });
    }

    private static void ApplyTrackingAdjustments(List<AlertItem> items, Dictionary<string, TrackingAdjustment> adjustments,
        IReadOnlyDictionary<string, List<ProfileRow>> profiles, DateTime today)
    {
        foreach (var item in items)
        {
            item.source_required_qty = item.required_qty; item.source_ordered_qty = item.ordered_qty;
            item.source_received_qty = item.received_qty; item.source_outbound_qty = item.outbound_qty;
            foreach (var detail in item.order_details)
            {
                if (!adjustments.TryGetValue(detail.key, out var adjustment)) continue;
                detail.adjustment_version = adjustment.version;
                if (!adjustment.active) continue;
                detail.adjustment = adjustment; item.has_adjustments = true;
                detail.required_qty_exact = Math.Max(0, detail.source_required_qty + (adjustment.required_delta ?? 0));
                detail.required_qty = decimal.Round(detail.required_qty_exact, 4);
                detail.ordered_qty = AdjustedQuantity(detail.source_ordered_qty, adjustment.ordered_qty, adjustment.ordered_base);
                detail.received_qty = AdjustedQuantity(detail.source_received_qty, adjustment.received_qty, adjustment.received_base);
                detail.outbound_qty = AdjustedQuantity(detail.source_outbound_qty, adjustment.outbound_qty, adjustment.outbound_base);
                detail.manual_qty_exact = AdjustedQuantity(detail.source_manual_qty, adjustment.manual_qty, adjustment.manual_base);
                detail.manual_qty = decimal.Round(detail.manual_qty_exact, 4);
                detail.manually_covered = detail.manual_qty_exact >= detail.required_qty_exact;
                detail.receipt_shortage_exact = Math.Max(detail.required_qty_exact - Math.Max(detail.manual_qty_exact, detail.received_qty), 0);
                detail.outbound_shortage_exact = Math.Max(detail.required_qty_exact - Math.Max(detail.manual_qty_exact, detail.outbound_qty), 0);
                var covered = detail.receipt_shortage_exact == 0 && detail.outbound_shortage_exact == 0;
                detail.status = covered ? "已完成(手动)"
                    : adjustment.status is "已送完" or "部分已送完" ? "部分已送完(手动)"
                    : adjustment.status != null ? adjustment.status + "(手动)"
                    : WorkflowStatus(detail.required_qty_exact, detail.ordered_qty, detail.received_qty, detail.outbound_qty, item.tracking_type != "purchase") + "(手动)";
            }
            if (!item.has_adjustments) continue;
            var details = item.order_details;
            item.required_qty = decimal.Round(details.Sum(d => d.required_qty_exact), 4);
            item.ordered_qty = Math.Max(0, item.source_ordered_qty + details.Sum(d => d.ordered_qty - d.source_ordered_qty));
            item.received_qty = Math.Max(0, item.source_received_qty + details.Where(d => d.adjustment != null).Sum(d => d.received_qty - d.source_received_qty));
            item.outbound_qty = Math.Max(0, item.source_outbound_qty + details.Where(d => d.adjustment != null).Sum(d => d.outbound_qty - d.source_outbound_qty));
            item.receipt_shortage_qty = decimal.Round(details.Sum(d => d.receipt_shortage_exact), 4);
            item.outbound_shortage_qty = item.shortage_qty = decimal.Round(details.Sum(d => d.outbound_shortage_exact), 4);
            item.purchase_shortage_qty = decimal.Round(details.Sum(d => Math.Max(d.required_qty_exact - Math.Max(d.manual_qty_exact, d.ordered_qty), 0)), 4);
            item.manual_completed = details.All(d => d.manually_covered);
            var profile = ResolveProfile(profiles, item.product_code, item.lead_category, item.material_name);
            var timing = OutstandingTiming(details, profile);
            item.accepted_date = timing.accepted?.ToString("yyyy-MM-dd") ?? "";
            item.due_date = timing.due?.ToString("yyyy-MM-dd");
            item.days_remaining = timing.due.HasValue ? (timing.due.Value - today).Days : null;
            item.status = timing.accepted is null ? "covered" : timing.due is null ? "unconfigured"
                : item.days_remaining <= 3 ? "critical" : item.days_remaining <= 7 ? "warning" : "normal";
            item.workflow_status = item.status == "covered" ? "已完成(含手动调整)"
                : string.Join("·", details.Select(d => d.status).Distinct());
        }
    }
}
