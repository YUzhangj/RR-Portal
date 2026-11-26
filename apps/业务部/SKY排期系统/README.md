# SKY 排期系统

上传排期 Excel 和 PO PDF 后，系统识别订单，供人工核对，再导出更新后的排期 Excel。支持 Sky Castle、TOMY 和 Jazwares 的 PO 格式。

安装 Node.js 后，在本目录运行 `npm install` 和 `npm start`，再打开 `http://127.0.0.1:3200`。先上传排期表，再上传 PO PDF，核对结果后点击「写入排期Excel」。

服务默认仅监听本机。上传文件和导出文件保存在 `data/`，也可通过 `DATA_PATH` 指定目录。门户入口位于业务部，访问路径为 `/sky-po-scheduling/`。云端由门户网关认证，上传文件及历史记录由该应用保存。
