import { NextRequest, NextResponse } from "next/server";
import { hasPage, type PageGrants } from "@/lib/page-permissions";

export const backendBaseUrl = process.env.VOYAGEPLEX_API_BASE_URL || "http://127.0.0.1:5088";

export function backendHeaders(request: Request, values?: HeadersInit) {
  const headers = new Headers(values);
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

export async function backendFetch(request: Request, path: string, init: RequestInit = {}) {
  return fetch(`${backendBaseUrl}${path}`, {
    ...init,
    headers: backendHeaders(request, init.headers),
    cache: "no-store",
  });
}

export async function proxyResponse(response: Response) {
  const headers = new Headers();
  headers.set("content-type", response.headers.get("content-type") || "application/json");
  const disposition = response.headers.get("content-disposition");
  if (disposition) headers.set("content-disposition", disposition);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) headers.set("set-cookie", setCookie);
  // HTTP forbids a response body for these statuses, including an empty buffer.
  const body = [204, 205, 304].includes(response.status) ? null : await response.arrayBuffer();
  return new NextResponse(body, { status: response.status, headers });
}

export async function requireRole(request: NextRequest, roles: Array<"admin" | "supervisor" | "shipping" | "warehouse">) {
  try {
    const response = await backendFetch(request, "/api/auth/me");
    if (!response.ok) return { response: NextResponse.json({ error:"请先登录" }, { status:401 }) };
    const user = await response.json() as { companyAccess?:string; pagePermissions:PageGrants; role:"admin" | "supervisor" | "shipping" | "warehouse" };
    const company = request.cookies.get("voyageplex_company")?.value || "Xingxin";
    if (!["Xingxin","Huadeng"].includes(company) || (user.role!=="admin" && (user.companyAccess||"Xingxin")!==company)) return { response: NextResponse.json({ error:"当前账号无权访问该公司板块" }, {status:403}) };
    if (user.role!=="supervisor" && !roles.includes(user.role)) return { response: NextResponse.json({ error:"当前账号无权使用此功能" }, { status:403 }) };
    // These handlers either read/write local files or call the parser directly, so
    // they must enforce grants before bypassing the API's middleware.
    const path = request.nextUrl.pathname.replace(process.env.NEXT_PUBLIC_BASE_PATH || "", "");
    let page = ""; let read = request.method === "GET" || request.method === "HEAD";
    if (path.startsWith("/api/inventory/local-files/")) { page = "inventory"; read = path.endsWith("/scan") || path.endsWith("/match"); }
    else if (path.startsWith("/api/inspection-mappings")) page = "settings.inspection";
    else if (path.startsWith("/api/product-infos")) { page = "settings.products"; if (path.endsWith("/preview")) read = true; }
    else if (path.startsWith("/api/factory-mappings")) page = "settings.factory";
    else if (path.startsWith("/api/qc/")) { page = "shipments"; read = true; }
    if (page && !hasPage(user.pagePermissions || {}, page, !read)) return { response: NextResponse.json({ error:"当前账号没有此页面的查看或操作权限" }, { status:403 }) };
    return { user };
  } catch {
    return { response: NextResponse.json({ error:"后台服务连接失败" }, { status:502 }) };
  }
}
