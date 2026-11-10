using System.Text.Json;
using System.Text.Json.Nodes;
using VoyagePlex.Api.Entities;

namespace VoyagePlex.Api.Services;

// Page grants can only narrow the existing role and company restrictions.
public static class PagePermissions
{
    public static readonly string[] Pages = ["home", "mail.workbench", "mail.contacts", "mail.recovery", "mail.settings", "imports", "shipments", "inventory", "users", "settings.directory", "settings.factory", "settings.templates", "settings.inspection", "settings.products"];
    private static readonly string[] Shipping = ["home", "mail.workbench", "mail.contacts", "imports", "shipments", "settings.directory", "settings.factory", "settings.templates"];
    private static readonly string[] Warehouse = ["home", "shipments", "inventory"];
    public static Dictionary<string, string> Defaults(string role) => Pages.ToDictionary(page => page, page =>
        role == "admin" || (role == "supervisor" && page != "mail.recovery") ||
        (role == "shipping" && Shipping.Contains(page)) || (role == "warehouse" && Warehouse.Contains(page)) ? "edit" : "none");
    public static int Rank(string? value) => value switch { "view" => 1, "edit" => 2, _ => 0 };
    // ASP.NET routes ignore case and accept a trailing slash. Authorization must
    // interpret the same resource as the endpoint, including user mutations.
    public static string NormalizePath(string path) => path.TrimEnd('/').ToLowerInvariant();
    public static bool Within(AppUser target, AppUser actor)
    {
        var ceiling = Effective(actor);
        return Effective(target).All(p => Rank(p.Value) <= Rank(ceiling[p.Key]));
    }
    public static bool CanManage(AppUser actor, AppUser? target, string company)
    {
        if (!actor.IsActive) return false;
        if (actor.Role == "admin") return true;
        return actor.Role == "supervisor" && actor.CompanyAccess == company &&
            Rank(Effective(actor)["users"]) == 2 && (target is null ||
            (target.CompanyAccess == company && (target.Role is "shipping" or "warehouse") && Within(target, actor)));
    }
    public static Dictionary<string, string> Effective(AppUser user)
    {
        var limits = Defaults(user.Role);
        if (user.Role == "admin" || string.IsNullOrEmpty(user.PagePermissionsJson)) return limits;
        try
        {
            var saved = JsonSerializer.Deserialize<Dictionary<string, string>>(user.PagePermissionsJson) ?? new();
            return Pages.ToDictionary(page => page, page => Rank(saved.GetValueOrDefault(page)) <= Rank(limits[page]) && Rank(saved.GetValueOrDefault(page)) > 0 ? saved[page] : "none");
        }
        catch (JsonException) { return Pages.ToDictionary(page => page, _ => "none"); }
    }
    public static string? Validate(JsonNode? node, string role, AppUser actor, out string json)
    {
        json = "";
        if (node is not JsonObject values) return "页面权限格式无效";
        if (values.Any(p => !Pages.Contains(p.Key) || p.Value is not JsonValue || p.Value.ToString() is not ("none" or "view" or "edit"))) return "页面权限包含无效选项";
        var limits = Defaults(role); var actorGrants = Effective(actor);
        var result = Pages.ToDictionary(page => page, page => values[page]?.ToString() ?? "none");
        if (result.Any(p => Rank(p.Value) > Rank(limits[p.Key]))) return "页面权限不能超出该角色的权限范围";
        if (actor.Role != "admin" && result.Any(p => Rank(p.Value) > Rank(actorGrants[p.Key]))) return "不能授予超出自己拥有的页面权限";
        json = JsonSerializer.Serialize(result); return null;
    }
    public static bool Allows(AppUser user, string path, string method)
    {
        path = NormalizePath(path);
        if (user.Role == "admin") return true;
        if (path is "/api/auth/me" or "/api/auth/logout") return true;
        var read = method is "GET" or "HEAD";
        string[] pages;
        if (path.StartsWith("/api/users", StringComparison.Ordinal)) pages = ["users"];
        else if (path.StartsWith("/api/mail/contacts", StringComparison.Ordinal)) pages = ["mail.contacts"];
        else if (path.StartsWith("/api/mail/settings", StringComparison.Ordinal)) pages = ["mail.settings"];
        else if (path.Contains("/mailbox/failed", StringComparison.Ordinal) || path.Contains("/mailbox/retry-failed", StringComparison.Ordinal) || path.Contains("/mailbox/backfill-missing", StringComparison.Ordinal)) pages = ["mail.recovery"];
        else if (path.StartsWith("/api/mail/accounts", StringComparison.Ordinal)) { pages = ["mail.workbench", "mail.contacts", "mail.settings", "mail.recovery"]; read = true; }
        else if (path.StartsWith("/api/mail", StringComparison.Ordinal) || path.StartsWith("/api/imports/email/mailbox", StringComparison.Ordinal)) pages = ["mail.workbench"];
        else if (path == "/api/imports/email/split-preview") { pages = ["imports", "mail.workbench"]; read = true; }
        else if (path.StartsWith("/api/imports/email", StringComparison.Ordinal)) pages = ["imports"];
        else if (path.StartsWith("/api/factory-mappings", StringComparison.Ordinal)) { pages = ["settings.factory"]; if (path.EndsWith("/parse", StringComparison.Ordinal)) read = true; }
        else if (path == "/api/export-templates/available") pages = ["shipments", "inventory"];
        else if (path.StartsWith("/api/export-templates", StringComparison.Ordinal)) pages = ["settings.templates"];
        else if (path.StartsWith("/api/inspection-mappings", StringComparison.Ordinal)) pages = ["settings.inspection"];
        else if (path.StartsWith("/api/product-infos", StringComparison.Ordinal)) { pages = ["settings.products"]; if (path.EndsWith("/preview", StringComparison.Ordinal)) read = true; }
        else if (path.StartsWith("/api/inventory", StringComparison.Ordinal)) pages = ["inventory"];
        else if (path.StartsWith("/api/shipments", StringComparison.Ordinal))
        {
            if (path.Contains("inventory-adjustment", StringComparison.Ordinal) || path.Contains("warehouse-locations", StringComparison.Ordinal) || path.Contains("export/warehouse", StringComparison.Ordinal)) pages = ["inventory"];
            else if (read && path == "/api/shipments") pages = ["shipments", "inventory", "home"];
            else if (read) pages = ["shipments", "inventory"];
            else pages = user.Role == "warehouse" ? ["inventory", "shipments"] : ["shipments"];
        }
        else if (path == "/api/modules") pages = ["home"];
        else return false;
        if (path.StartsWith("/api/shipments/", StringComparison.Ordinal) &&
            (path.EndsWith("/export", StringComparison.Ordinal) || path.Contains("/export/", StringComparison.Ordinal) || path.EndsWith("/warehouse-export", StringComparison.Ordinal))) read = false;
        var effective = Effective(user); return pages.Any(page => Rank(effective[page]) >= (read ? 1 : 2));
    }
}
