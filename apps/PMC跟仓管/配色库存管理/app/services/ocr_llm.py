"""通过阿里云百炼 (Bailian) 的 OpenAI 兼容端点调用通义千问 VL 识别送货单 / 出入库单。

云端 ECS 在中国大陆，百炼国内直连稳定。

环境变量:
  BAILIAN_API_KEY     必填, 阿里云百炼 API key
                       (https://bailian.console.aliyun.com/?tab=model#/api-key)
  BAILIAN_MODEL       可选, 默认 qwen3-vl-plus
                       (模型、API key、端点地域和业务空间权限需一致)
  BAILIAN_BASE_URL    可选, 默认 https://dashscope.aliyuncs.com/compatible-mode/v1
"""
from __future__ import annotations

import base64
from io import BytesIO
import json
import os
import re

import requests
from PIL import Image

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen3-vl-plus"

SYSTEM_PROMPT = """你是一个送货单/出入库单识别助手。
给你一张图片,请只返回 JSON 数组,格式:
[{"purchase_code": "色粉/进货编号", "name": "品名或颜色", "quantity": 数字, "unit_price": 数字}]

规则:
- 只返回商品明细行,跳过表头、合计/总计、公司抬头、日期、备注、大写金额等。
- quantity 是数字(不带单位),unit_price 去掉 ¥/￥/Y 符号和千分位逗号。
- purchase_code 取最能唯一定位商品的编号(如 FK-20、89047色种、94387);若只有名称则编号留空。
- 如果图片里没有商品行,返回 []。
"""


_ERROR_MESSAGES = {
    "missing_key": "百炼 OCR 未配置 API 密钥，请联系管理员检查 BAILIAN_API_KEY。",
    "invalid_image": "上传的图片无法读取，请使用完整的 JPG 或 PNG 图片。",
    "timeout": "百炼 OCR 请求超时，请稍后重试。",
    "network": "暂时无法连接百炼 OCR 服务，请稍后重试或联系管理员检查网络与端点配置。",
    "auth": "百炼 OCR 鉴权失败，请联系管理员检查 API 密钥和区域端点。",
    "permission": "百炼 OCR 暂无访问权限，请联系管理员检查模型权限、密钥和区域端点。",
    "model_unavailable": "当前百炼 OCR 模型不可用或账号无访问权限，请联系管理员检查模型可用性。",
    "rate_limit": "百炼 OCR 请求受限，请稍后重试或联系管理员检查服务额度。",
    "upstream": "百炼 OCR 服务暂时不可用，请稍后重试。",
    "http": "百炼 OCR 请求被拒绝，请联系管理员检查模型及端点配置。",
    "response_json": "百炼 OCR 返回了无效响应，请稍后重试。",
    "response_structure": "百炼 OCR 响应格式异常，请稍后重试。",
    "content_format": "百炼 OCR 未返回有效的识别明细，请尝试更清晰的图片。",
    "unexpected": "百炼 OCR 识别发生异常，请稍后重试或联系管理员。",
}


class LLMOCRError(Exception):
    """Only fixed error categories and an HTTP status may reach users or logs."""

    def __init__(self, code: str = "unexpected", *, status: int | None = None):
        self.code = code if isinstance(code, str) and code in _ERROR_MESSAGES else "unexpected"
        self.status = (status if type(status) is int and 100 <= status <= 599 else None)
        message = _ERROR_MESSAGES[self.code]
        if self.status is not None:
            message += f"（HTTP {self.status}）"
        super().__init__(message)


def _is_model_unavailable(resp) -> bool:
    """Recognize a fixed provider code; never retain arbitrary diagnostic values."""
    try:
        data = resp.json()
    except ValueError:
        return False
    if not isinstance(data, dict):
        return False
    error = data.get("error")
    return (data.get("code") == "model_not_found" or
            isinstance(error, dict) and error.get("code") == "model_not_found")


def parse_image_llm(
    image_bytes: bytes,
    pigment_lookup: dict[str, int],
    timeout: int = 60,
) -> list[dict]:
    api_key = os.environ.get("BAILIAN_API_KEY", "").strip()
    if not api_key:
        raise LLMOCRError("missing_key")
    model = os.environ.get("BAILIAN_MODEL", "").strip() or DEFAULT_MODEL
    base = (os.environ.get("BAILIAN_BASE_URL", "").strip().rstrip("/") or DEFAULT_BASE_URL)
    url = f"{base}/chat/completions"

    try:
        with Image.open(BytesIO(image_bytes)) as image:
            mime = Image.MIME.get(image.format)
            image.verify()
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise LLMOCRError("invalid_image") from None
    if not mime:
        raise LLMOCRError("invalid_image")
    b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "请识别并严格按 JSON 数组返回。"},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            },
        ],
        "temperature": 0,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
    except requests.Timeout:
        raise LLMOCRError("timeout") from None
    except requests.RequestException:
        raise LLMOCRError("network") from None
    if resp.status_code != 200:
        status = resp.status_code
        code = {401: "auth", 403: "permission", 429: "rate_limit"}.get(status)
        if code is None:
            code = "upstream" if 500 <= status <= 599 else "http"
            if code == "http" and _is_model_unavailable(resp):
                code = "model_unavailable"
        raise LLMOCRError(code, status=status)
    try:
        data = resp.json()
    except ValueError:
        raise LLMOCRError("response_json") from None
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise LLMOCRError("response_structure") from None
    if not isinstance(content, str):
        raise LLMOCRError("content_format")

    rows = _extract_json_array(content)
    return [_normalize_row(r, pigment_lookup) for r in rows if isinstance(r, dict)]


_FENCE_RE = re.compile(r"```(?:json)?\s*(.+?)\s*```", re.DOTALL)


def _extract_json_array(content: str):
    m = _FENCE_RE.search(content)
    if m:
        content = m.group(1)
    start = content.find("[")
    end = content.rfind("]")
    if start < 0 or end <= start:
        raise LLMOCRError("content_format")
    try:
        return json.loads(content[start:end + 1])
    except json.JSONDecodeError:
        raise LLMOCRError("content_format") from None


def _to_float(v) -> float:
    if v is None:
        return 0.0
    s = str(v).strip().replace(",", "").replace("￥", "").replace("¥", "")
    s = re.sub(r"[^0-9.\-]", "", s)
    try:
        return float(s) if s else 0.0
    except ValueError:
        return 0.0


def _normalize_row(r: dict, pigment_lookup: dict[str, int]) -> dict:
    code = str(r.get("purchase_code") or "").strip()
    name = str(r.get("name") or "").strip()
    qty = _to_float(r.get("quantity"))
    price = _to_float(r.get("unit_price"))
    pigment_id = None
    if code:
        low = code.lower()
        pigment_id = pigment_lookup.get(low)
        if pigment_id is None and low.startswith(("a", "b")) and len(low) > 1:
            pigment_id = pigment_lookup.get(low[1:])
    return {
        "raw": f"{code} {name} {qty} {price}".strip(),
        "pigment_id": pigment_id,
        "purchase_code": code,
        "quantity": qty,
        "unit_price": price,
    }
