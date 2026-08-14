using Microsoft.EntityFrameworkCore;
using Npgsql;
using System.Text.RegularExpressions;

namespace IndoShipping.Infrastructure.Persistence;

public static class DatabaseCompatibility
{
    public static async Task EnsureAsync(AppDbContext db)
    {
        if (!db.Database.IsRelational()) return;

        // 连接归 DbContext 所有，不能 using/await using 释放——否则 EnsureAsync 返回后
        // 后续复用同一 context 的代码（如 ProductionSeeder）会拿到已 Dispose 的连接，
        // 抛 ObjectDisposedException。连接的释放由 context 自己负责。
        var connection = db.Database.GetDbConnection();
        if (connection.State != System.Data.ConnectionState.Open)
            await connection.OpenAsync();

        // postgres_schema.sql 全量幂等（CREATE ... IF NOT EXISTS / ON CONFLICT DO NOTHING /
        // DO $$ 守卫），每次启动都执行：首启建表，后续 schema 增量（ALTER ADD COLUMN
        // IF NOT EXISTS 等）也能自愈落地，无需人工迁移流程。
        var scriptPath = Path.Combine(AppContext.BaseDirectory, "db", "postgres_schema.sql");
        if (!File.Exists(scriptPath))
            throw new FileNotFoundException($"未找到建表脚本 {scriptPath}（镜像应 COPY db/postgres_schema.sql）");
        // 不能用 ExecuteSqlRawAsync：EF 会把 SQL 过 string.Format，
        // 脚本里 CHECK 正则的 '{9}' 会被当占位符直接 FormatException。
        // 走原生 ADO.NET 命令，无格式化、支持多语句批量执行。
        var script = await File.ReadAllTextAsync(scriptPath);
        var configuredSchema = new NpgsqlConnectionStringBuilder(connection.ConnectionString).SearchPath;
        if (!string.IsNullOrWhiteSpace(configuredSchema))
        {
            // DeploymentSecrets accepts a single schema name. Make the bootstrap script
            // follow that selection instead of silently switching every connection back
            // to indo_shipping (local installations historically use dbo).
            if (!Regex.IsMatch(configuredSchema, "^[A-Za-z_][A-Za-z0-9_]*$"))
                throw new InvalidOperationException($"Invalid PostgreSQL schema name: {configuredSchema}");
            var quotedSchema = $"\"{configuredSchema}\"";
            script = script
                .Replace("CREATE SCHEMA IF NOT EXISTS indo_shipping;", $"CREATE SCHEMA IF NOT EXISTS {quotedSchema};")
                .Replace("SET search_path TO indo_shipping;", $"SET search_path TO {quotedSchema};");
        }

        await using var command = connection.CreateCommand();
        command.CommandText = script;
        command.CommandTimeout = 120;
        await command.ExecuteNonQueryAsync();
    }
}
