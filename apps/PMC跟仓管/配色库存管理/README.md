# 配色库存管理系统

单人本地使用的颜料/油漆库存管理 Web 应用。

## 启动

    pip install -r requirements.txt
    python run.py

浏览器访问 http://127.0.0.1:5000

## 功能

- 颜料档案（品牌/色号/色样/规格/低库存阈值）
- 当前库存与低库存预警
- 出入库流水（入库 / 出库 / 盘点）
- 调色配方（可行性检查、按配方一键出库）
- Excel 导入 / 导出 / 模板下载

## 单据图片识别

设置 `BAILIAN_API_KEY` 后可识别出入库单。默认模型为 `qwen3-vl-plus`，默认端点为北京区域的
`https://dashscope.aliyuncs.com/compatible-mode/v1`。可通过 `BAILIAN_MODEL` 和 `BAILIAN_BASE_URL`
显式覆盖；模型、API key、端点地域和业务空间权限需一致。

识别失败时页面保留百炼的安全分类原因；模型不可用时需检查模型访问权限，不会自动切换模型。
识别成功只生成核对预览，确认提交后才写入出入库流水。

## 测试

    python -m pytest -v --ignore=tests/test_full_regression.py

`test_full_regression.py` 是连接运行中应用并写入数据库的手工脚本，不属于隔离单元测试。

## 数据存储

SQLite 文件位于 `instance/peise.db`。定期备份该文件即可。

## 技术栈

Flask · SQLAlchemy · Pandas · openpyxl · Bootstrap 5 · DataTables · Chart.js
