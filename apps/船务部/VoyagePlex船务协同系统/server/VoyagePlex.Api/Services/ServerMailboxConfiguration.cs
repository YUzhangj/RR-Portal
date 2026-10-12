using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using VoyagePlex.Api.Entities;

namespace VoyagePlex.Api.Services;

public sealed record ServerMailboxCredentials(string Address, string AuthCode, string Host, string Folder);

public static class ServerMailboxConfiguration
{
    public const string EnvironmentVariable = "VOYAGEPLEX_HUADENG_MAILBOXES_JSON";

    public static bool IsConfigured(AppUser user) => TryGet(user, out _, out _);

    public static string MailboxIdentity(string address, string host, string folder) =>
        Hash(JsonSerializer.Serialize(new { address = address.Trim().ToLowerInvariant(), host = host.Trim().ToLowerInvariant(), folder = folder.Trim() }));

    public static string MailboxIdentity(ServerMailboxCredentials credentials) =>
        MailboxIdentity(credentials.Address, credentials.Host, credentials.Folder);

    public static string ConfigurationKey(ServerMailboxCredentials credentials) =>
        Hash(JsonSerializer.Serialize(new { identity = MailboxIdentity(credentials), credentials.AuthCode }));

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public static bool TryGet(AppUser user, out ServerMailboxCredentials credentials, out string error)
    {
        credentials = new ServerMailboxCredentials("", "", "", "");
        error = "服务器尚未配置该用户的华登邮箱";
        if (string.IsNullOrWhiteSpace(user.MailboxAddress))
        {
            error = "该用户尚未绑定华登邮箱地址";
            return false;
        }

        var value = Environment.GetEnvironmentVariable(EnvironmentVariable);
        if (string.IsNullOrWhiteSpace(value))
        {
            error = "服务器尚未配置华登邮箱连接";
            return false;
        }

        try
        {
            var entries = JsonSerializer.Deserialize<List<ServerMailboxEntry?>>(value, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
            if (entries.Any(item => item is null || string.IsNullOrWhiteSpace(item.Username)) ||
                entries.GroupBy(item => item!.Username!.Trim(), StringComparer.OrdinalIgnoreCase).Any(group => group.Count() > 1) ||
                entries.Where(item => !string.IsNullOrWhiteSpace(item!.Address)).GroupBy(item => item!.Address!.Trim(), StringComparer.OrdinalIgnoreCase).Any(group => group.Count() > 1))
            {
                error = "服务器邮箱配置包含空条目或重复的用户、邮箱";
                return false;
            }
            var entry = entries.FirstOrDefault(item => string.Equals(item!.Username!.Trim(), user.Username, StringComparison.OrdinalIgnoreCase));
            if (entry is null) return false;
            var address = entry.Address?.Trim().ToLowerInvariant() ?? "";
            var host = entry.Host?.Trim() ?? "";
            var folder = entry.Folder?.Trim() ?? "";
            if (!string.Equals(address, user.MailboxAddress, StringComparison.OrdinalIgnoreCase))
            {
                error = "服务器邮箱配置与该用户绑定的邮箱地址不一致";
                return false;
            }
            if (string.IsNullOrWhiteSpace(entry.AuthCode) || entry.AuthCode.Length > 1024 || host.Length > 253 || Uri.CheckHostName(host) != UriHostNameType.Dns || folder.Length is < 1 or > 100 || folder.Any(char.IsControl))
            {
                error = "服务器邮箱配置缺少有效的授权码、服务器或文件夹";
                return false;
            }
            credentials = new ServerMailboxCredentials(address, entry.AuthCode, host, folder);
            error = "";
            return true;
        }
        catch (JsonException)
        {
            error = "服务器华登邮箱配置格式无效";
            return false;
        }
    }

    private sealed record ServerMailboxEntry(string? Username, string? Address, string? AuthCode, string? Host, string? Folder);
}
