import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { permRowsToMap, renderWithProviders } from "../test/setup";
import App from "../App";

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200, headers: { "Content-Type": "application/json" },
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("应用外壳", () => {
  it("根路由渲染宫格首页且没有旧 POS 入口", async () => {
    const seen = new Set<string>();
    const unexpected: string[] = [];
    const listPaths = ["production", "replenishments", "material-issues", "purchase-orders", "assembly-purchase-orders"];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://shell-fixture.invalid").pathname;
      const method = init?.method ?? "GET";
      seen.add(`${method} ${path}`);
      if (method === "GET") {
        if (path === "/api/auth/me/permissions") return json(permRowsToMap([{ 菜单: "账号管理", 打开: true }]));
        if (path === "/api/messages/unread-count") return json({ count: 0 });
        if (path === "/api/admin/accounts" || path === "/api/material-inventory") return json([]);
        if (listPaths.some(resource => path === `/api/${resource}`)) return json({ items: [], total: 0 });
      }
      if (method === "POST" && path === "/api/auth/heartbeat") return json({});
      unexpected.push(`${method} ${path}`);
      throw new Error(`未定义的外壳测试请求：${method} ${path}`);
    }));
    localStorage.setItem("web2.token", "shell-fixture-token");
    localStorage.setItem("web2.user", "shell-fixture-user");
    renderWithProviders(<App />);

    // 等待懒加载宫格就绪，明确区分侧栏按钮与首页同名部门标题。
    expect(await screen.findByRole("heading", { name: "工作台", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "工程部" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "工程部", level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /POS/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /POS/i })).not.toBeInTheDocument();
    await waitFor(() => expect([...seen].sort()).toEqual([
      "GET /api/auth/me/permissions", "GET /api/messages/unread-count", "GET /api/admin/accounts",
      "GET /api/material-inventory", ...listPaths.map(resource => `GET /api/${resource}`),
      "POST /api/auth/heartbeat",
    ].sort()));
    expect(unexpected).toEqual([]);
  });
});
