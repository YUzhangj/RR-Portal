export type PagePermission = "none" | "view" | "edit";
export type PageGrants = Record<string, PagePermission>;
export type PermissionRole = "admin" | "supervisor" | "shipping" | "warehouse";
export const permissionPages = [
  ["home", "首页"], ["mail.workbench", "每日邮件确认"], ["mail.contacts", "联系人整理"], ["mail.recovery", "历史失败补信"], ["mail.settings", "邮箱同步设置"],
  ["imports", "信息导入"], ["shipments", "走柜任务"], ["inventory", "库存管理"], ["users", "用户管理"],
  ["settings.directory", "文件夹目录"], ["settings.factory", "工厂名映射"], ["settings.templates", "导出模板管理"], ["settings.inspection", "验货映射"], ["settings.products", "产品信息库"],
] as const;
const shipping = ["home", "mail.workbench", "mail.contacts", "imports", "shipments", "settings.directory", "settings.factory", "settings.templates"];
const warehouse = ["home", "shipments", "inventory"];
export function defaultPagePermissions(role: PermissionRole): PageGrants {
  return Object.fromEntries(permissionPages.map(([key]) => [key, role === "admin" || (role === "supervisor" && key !== "mail.recovery") || (role === "shipping" && shipping.includes(key)) || (role === "warehouse" && warehouse.includes(key)) ? "edit" : "none"]));
}
export function hasPage(grants: PageGrants, key: string, edit = false) { return grants[key] === "edit" || (!edit && grants[key] === "view"); }
