/**
 * 网页版资料编辑器：在浏览器里直接编辑 xlsx（Luckysheet），保存回系统服务器。
 * 每个人在自己电脑的浏览器里编辑，不会调用任何电脑上的 Excel。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ensureLuckysheet } from "@/lib/luckysheet-loader";
import { luckyToXlsx } from "@/lib/lucky-to-xlsx";
import { api } from "@/lib/api";
import { useEpmsAccess } from "@/lib/epms-access";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, Loader2, Save } from "lucide-react";

const CONTAINER_ID = "luckysheet-editor-container";

export default function DocEditor({
  path,
  name,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  path: string;
  name: string;
  onClose: () => void;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { session } = useEpmsAccess();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [baseMtime, setBaseMtime] = useState(0);
  const dirtyRef = useRef(false);
  const destroyedRef = useRef(false);
  const [resolvedPath, setResolvedPath] = useState(path);
  const [access, setAccess] = useState<{ requestedPath: string; path: string; actorId?: string; readOnly: boolean; reason?: string } | null>(null);
  const writable = Boolean(session?.canEdit && access?.readOnly === false && access.requestedPath === path
    && access.path === resolvedPath && access.actorId === session.id);
  const dir = resolvedPath.includes("/") ? resolvedPath.slice(0, resolvedPath.lastIndexOf("/")) : "";
  const fileName = resolvedPath.split("/").pop() || name;

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    onDirtyChange?.(true);
  }, [onDirtyChange]);

  useEffect(() => {
    destroyedRef.current = false;
    let cancelled = false;
    (async () => {
      try {
        let p = path;
        if (!/\.xlsx$/i.test(p)) {
          if (!/\.xls$/i.test(p)) {
            throw new Error("此文件格式暂不支持网页编辑，请下载后用对应软件打开");
          }
          // 旧版 .xls：若旁边已有转换好的 .xlsx（批量转换产生），直接改开它
          const alt = p.replace(/\.xls$/i, ".xlsx");
          try {
            await api.stat(alt);
            p = alt;
            if (!cancelled) setResolvedPath(alt);
          } catch {
            throw new Error("旧版 .xls 文件暂不支持网页编辑，请下载后用 Excel 打开编辑");
          }
        }
        const checked = await api.editorAccess(p).catch(() => ({ readOnly: true, reason: "暂时无法核对编辑权限，请重新登录或联系管理员；当前仅可查看和下载" }));
        if (checked.readOnly && [
          "审核中或已归档资料不可通过文件接口改写、改名或删除",
          "含制单记录的项目不能通过旧文件接口移动或删除",
          "编辑锁已失效或属于其他窗口，请重新读取并获取锁",
        ].includes(checked.reason || "")) checked.reason = "历史受控资料已保留，当前界面仅供查看";
        if (cancelled) return;
        const canWrite = Boolean(session?.canEdit && checked.readOnly === false);
        setAccess({ ...checked, requestedPath: path, path: p, actorId: session?.id });
        setResolvedPath(p);
        setPhase("loading");
        dirtyRef.current = false;
        setDirty(false);
        onDirtyChange?.(false);
        await ensureLuckysheet();
        // 记录打开时的修改时间，用于保存冲突检测
        try {
          const st = await api.stat(p);
          if (!cancelled) setBaseMtime(st.mtime);
        } catch {
          /* 拿不到就跳过冲突检测 */
        }
        const res = await fetch(api.fileUrl(p));
        if (!res.ok) throw new Error(`读取文件失败 (${res.status})`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        window.LuckyExcel.transformExcelToLucky(
          buf,
          (exportJson: { sheets?: unknown[]; info?: { name?: string } }) => {
            if (cancelled || destroyedRef.current) return;
            if (!exportJson?.sheets?.length) {
              setError("文件内容为空或格式无法识别");
              setPhase("error");
              return;
            }
            window.luckysheet.create({
              container: CONTAINER_ID,
              data: exportJson.sheets,
              title: fileName,
              lang: "zh",
              allowEdit: canWrite,
              showtoolbar: canWrite,
              showinfobar: false,
              showsheetbar: true,
              showstatisticBar: true,
              allowCopy: true,
              enableAddRow: canWrite,
              enableAddBackTop: true,
            });
            setPhase("ready");
            // 任何键盘/鼠标操作都标记为未保存
            const el = document.getElementById(CONTAINER_ID);
            if (canWrite) {
              el?.addEventListener("keydown", markDirty);
              el?.addEventListener("mousedown", markDirty);
            }
          },
          (err: unknown) => {
            if (cancelled) return;
            setError(`文件解析失败：${String(err)}`);
            setPhase("error");
          },
        );
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      destroyedRef.current = true;
      const el = document.getElementById(CONTAINER_ID);
      el?.removeEventListener("keydown", markDirty);
      el?.removeEventListener("mousedown", markDirty);
      dirtyRef.current = false;
      onDirtyChange?.(false);
      try {
        window.luckysheet?.destroy?.();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, session?.id, session?.canEdit]);

  // 关闭页面前提示未保存
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const doSave = useCallback(async () => {
    if (saving || phase !== "ready" || !writable) return;
    setSaving(true);
    try {
      const sheets = window.luckysheet.getAllSheets();
      const blob = await luckyToXlsx(sheets, fileName);
      const file = new File([blob], fileName, { type: blob.type });
      await api.upload(dir, file, undefined, { overwrite: true, baseMtime });
      dirtyRef.current = false;
      setDirty(false);
      onDirtyChange?.(false);
      const st = await api.stat(resolvedPath).catch(() => null);
      if (st) setBaseMtime(st.mtime);
      toast.success("已保存到系统");
      onSaved();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("409") || msg.includes("已被")) {
        toast.error("保存失败：这份资料刚被别人改过了。请下载当前内容备用，然后重新打开再改。");
      } else {
        toast.error(`保存失败：${msg}`);
      }
    } finally {
      setSaving(false);
    }
  }, [saving, phase, writable, dir, fileName, baseMtime, resolvedPath, onSaved, onDirtyChange]);

  // Ctrl+S 保存
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        doSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [doSave]);

  const doDownload = useCallback(async () => {
    try {
      const sheets = window.luckysheet.getAllSheets();
      const blob = await luckyToXlsx(sheets, fileName);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(`导出失败：${(e as Error).message}`);
    }
  }, [fileName]);

  const handleBack = useCallback(() => {
    if (dirtyRef.current && !window.confirm("有未保存的修改，确定不保存就离开吗？")) return;
    onClose();
  }, [onClose]);

  return (
    <div className="flex h-full flex-col">
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-white px-3 py-2">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> 返回
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="truncate text-xs text-slate-400">{resolvedPath}</div>
        </div>
        <span className={`text-xs ${dirty ? "text-amber-600" : "text-slate-400"}`}>
          {saving ? "保存中…" : dirty ? "有未保存的修改" : phase === "ready" ? "已保存" : ""}
        </span>
        <Button variant="outline" size="sm" onClick={doDownload} disabled={phase !== "ready"}>
          <Download className="mr-1 h-4 w-4" /> 下载
        </Button>
        <Button size="sm" onClick={doSave} disabled={saving || phase !== "ready" || !writable}>
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
          保存 (Ctrl+S)
        </Button>
      </div>

      {phase === "ready" && !writable && <div role="status" className="shrink-0 border-b bg-amber-50 px-3 py-2 text-sm text-amber-900">
        只读：{access?.reason || "当前账号没有工程资料编辑权限，可查看和下载"}
      </div>}

      {/* 编辑区 */}
      <div className="relative min-h-0 flex-1 bg-white">
        {phase === "loading" && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-white">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <p className="text-sm text-slate-500">正在加载编辑器…</p>
          </div>
        )}
        {phase === "error" && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white p-6">
            <p className="text-sm text-red-600">{error}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleBack}>
                返回
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(api.fileUrl(resolvedPath, true), "_blank")}
              >
                <Download className="mr-1 h-4 w-4" /> 下载文件
              </Button>
            </div>
          </div>
        )}
        <div id={CONTAINER_ID} className="absolute inset-0" />
      </div>
    </div>
  );
}
