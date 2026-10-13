"""Synthetic provider responses only; no external requests or business database."""
import base64
from io import BytesIO
import json
import traceback

import pytest
import requests
from PIL import Image

from app.services import ocr_llm


PRIVATE = "synthetic-private-provider-value"


def image_bytes(format="PNG"):
    output = BytesIO()
    Image.new("RGB", (2, 2), "white").save(output, format=format)
    return output.getvalue()


IMAGE_BYTES = image_bytes()


class Response:
    def __init__(self, status=200, data=None, failure=None):
        self.status_code = status
        self.data = data
        self.failure = failure

    @property
    def text(self):
        raise AssertionError("Raw provider response must not be read for diagnostics")

    def json(self):
        if self.failure:
            raise self.failure
        return self.data


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv("BAILIAN_API_KEY", PRIVATE)
    monkeypatch.setenv("BAILIAN_BASE_URL", "https://synthetic.invalid/compatible-mode/v1")
    monkeypatch.delenv("BAILIAN_MODEL", raising=False)

    def respond(response):
        monkeypatch.setattr(ocr_llm.requests, "post", lambda *args, **kwargs: response)

    return respond


def assert_safe(error, code, status=None):
    assert error.code == code
    assert error.status == status
    assert PRIVATE not in str(error)
    assert PRIVATE not in repr(error)
    assert PRIVATE not in "".join(traceback.format_exception(error))
    assert "synthetic.invalid" not in str(error)


def test_missing_key_fails_without_calling_provider(monkeypatch):
    monkeypatch.setenv("BAILIAN_API_KEY", "  ")
    monkeypatch.setattr(ocr_llm.requests, "post", lambda *args, **kwargs: pytest.fail("must not call provider"))
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(IMAGE_BYTES, {})
    assert_safe(caught.value, "missing_key")
    assert "BAILIAN_API_KEY" in str(caught.value)


@pytest.mark.parametrize("exception,code", [
    (requests.Timeout, "timeout"),
    (requests.ConnectTimeout, "timeout"),
    (requests.ReadTimeout, "timeout"),
    (requests.ConnectionError, "network"),
    (requests.exceptions.InvalidURL, "network"),
    (requests.RequestException, "network"),
])
def test_request_failures_do_not_expose_exception_or_url(provider, monkeypatch, exception, code):
    def fail(*args, **kwargs):
        raise exception(f"https://synthetic.invalid/?token={PRIVATE}")

    monkeypatch.setattr(ocr_llm.requests, "post", fail)
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(IMAGE_BYTES, {})
    assert_safe(caught.value, code)


@pytest.mark.parametrize("status,code", [
    (400, "http"), (401, "auth"), (403, "permission"), (404, "http"),
    (429, "rate_limit"), (500, "upstream"), (502, "upstream"), (503, "upstream"),
])
def test_http_failures_keep_only_category_and_status(provider, status, code):
    provider(Response(status, {"error": {"message": PRIVATE}}))
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(IMAGE_BYTES, {})
    assert_safe(caught.value, code, status)
    assert f"HTTP {status}" in str(caught.value)


@pytest.mark.parametrize("status,data", [
    (404, {"error": {"code": "model_not_found", "message": PRIVATE}}),
    (400, {"error": {"code": "model_not_found", "message": PRIVATE}}),
    (404, {"code": "model_not_found", "message": PRIVATE}),
])
def test_known_model_error_uses_fixed_model_availability_diagnostic(provider, status, data):
    provider(Response(status, data))
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(IMAGE_BYTES, {})
    assert_safe(caught.value, "model_unavailable", status)
    assert "模型不可用" in str(caught.value)


@pytest.mark.parametrize("data,failure", [
    (None, ValueError(PRIVATE)),
    ({"error": {"code": PRIVATE, "message": PRIVATE}}, None),
    ([PRIVATE], None),
])
def test_unknown_or_non_json_404_is_not_mislabeled_as_a_model_error(provider, data, failure):
    provider(Response(404, data, failure))
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(IMAGE_BYTES, {})
    assert_safe(caught.value, "http", 404)


def test_invalid_json_never_exposes_provider_body(provider):
    provider(Response(failure=ValueError(PRIVATE)))
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(IMAGE_BYTES, {})
    assert_safe(caught.value, "response_json")


@pytest.mark.parametrize("data", [None, [], {"error": PRIVATE}, {"choices": []},
    {"choices": [{"message": None}]}, {"choices": [{"message": {"wrong": PRIVATE}}]}])
def test_invalid_response_structure_never_exposes_values(provider, data):
    provider(Response(data=data))
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(IMAGE_BYTES, {})
    assert_safe(caught.value, "response_structure")


@pytest.mark.parametrize("content", [None, [PRIVATE], {"value": PRIVATE}, PRIVATE,
    f"```json\n[{PRIVATE}]\n```", "[1,]"])
def test_invalid_model_content_is_safe(provider, content):
    provider(Response(data={"choices": [{"message": {"content": content}}]}))
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(IMAGE_BYTES, {})
    assert_safe(caught.value, "content_format")


@pytest.mark.parametrize("content", ["[]", "```json\n[]\n```"])
def test_empty_success_is_preserved(provider, content):
    provider(Response(data={"choices": [{"message": {"content": content}}]}))
    assert ocr_llm.parse_image_llm(IMAGE_BYTES, {}) == []


def test_success_keeps_row_normalization_and_matching(provider):
    content = json.dumps([{"purchase_code": "B12", "name": "Synthetic pigment",
                           "quantity": "1,234", "unit_price": "￥2,600.50"}, "ignored non-row"])
    provider(Response(data={"choices": [{"message": {"content": f"```json\n{content}\n```"}}]}))
    rows = ocr_llm.parse_image_llm(IMAGE_BYTES, {"12": 7})
    assert len(rows) == 1
    assert rows[0]["purchase_code"] == "B12"
    assert rows[0]["pigment_id"] == 7
    assert rows[0]["quantity"] == 1234
    assert rows[0]["unit_price"] == 2600.5


@pytest.mark.parametrize("status", [None, PRIVATE, True, -1, 600])
def test_legacy_unknown_error_text_and_invalid_status_are_not_retained(status):
    error = ocr_llm.LLMOCRError(PRIVATE, status=status)
    assert_safe(error, "unexpected")


@pytest.mark.parametrize("format,mime", [("PNG", "image/png"), ("JPEG", "image/jpeg")])
def test_request_uses_actual_image_mime_without_changing_bytes(provider, monkeypatch, format, mime):
    image = image_bytes(format)
    sent = []

    def post(url, **kwargs):
        sent.append((url, kwargs))
        return Response(data={"choices": [{"message": {"content": "[]"}}]})

    monkeypatch.setattr(ocr_llm.requests, "post", post)
    assert ocr_llm.parse_image_llm(image, {}) == []
    assert len(sent) == 1
    url, kwargs = sent[0]
    assert url == "https://synthetic.invalid/compatible-mode/v1/chat/completions"
    assert kwargs["json"]["messages"][1]["content"][1]["image_url"]["url"] == (
        f"data:{mime};base64," + base64.b64encode(image).decode("ascii"))
    assert kwargs["headers"]["Authorization"] == f"Bearer {PRIVATE}"
    assert kwargs["timeout"] == 60


@pytest.mark.parametrize("configured_model", [None, "", "  "])
def test_unconfigured_model_sends_the_verified_default(provider, monkeypatch, configured_model):
    if configured_model is not None:
        monkeypatch.setenv("BAILIAN_MODEL", configured_model)
    sent_models = []

    def post(url, **kwargs):
        sent_models.append(kwargs["json"]["model"])
        return Response(data={"choices": [{"message": {"content": "[]"}}]})

    monkeypatch.setattr(ocr_llm.requests, "post", post)
    assert ocr_llm.DEFAULT_MODEL == "qwen3-vl-plus"
    assert ocr_llm.parse_image_llm(IMAGE_BYTES, {}) == []
    assert sent_models == ["qwen3-vl-plus"]


@pytest.mark.parametrize("configured_model,expected_model", [
    ("", "qwen3-vl-plus"), ("  synthetic-explicit-model  ", "synthetic-explicit-model")])
def test_model_unavailable_never_automatically_retries_a_different_model(
    provider, monkeypatch, configured_model, expected_model,
):
    monkeypatch.setenv("BAILIAN_MODEL", configured_model)
    sent_models = []

    def post(url, **kwargs):
        sent_models.append(kwargs["json"]["model"])
        return Response(404, {"error": {"code": "model_not_found", "message": PRIVATE}})

    monkeypatch.setattr(ocr_llm.requests, "post", post)
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(IMAGE_BYTES, {})
    assert_safe(caught.value, "model_unavailable", 404)
    assert sent_models == [expected_model]


@pytest.mark.parametrize("image", [b"", PRIVATE.encode(), IMAGE_BYTES[:10]])
def test_invalid_image_is_safe_and_never_calls_provider(provider, monkeypatch, image):
    monkeypatch.setattr(ocr_llm.requests, "post", lambda *args, **kwargs: pytest.fail("must not call provider"))
    with pytest.raises(ocr_llm.LLMOCRError) as caught:
        ocr_llm.parse_image_llm(image, {})
    assert_safe(caught.value, "invalid_image")
