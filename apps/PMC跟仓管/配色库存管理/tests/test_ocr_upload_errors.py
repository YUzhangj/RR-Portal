import html
import io
import logging

import pytest

from app.models import PendingReview, Pigment, Stock, Transaction
from app.services import ocr, ocr_llm


SECRET_SENTINEL = "SYNTHETIC_API_KEY_MUST_NOT_APPEAR"
PROVIDER_SENTINEL = "SYNTHETIC_PROVIDER_PAYLOAD_MUST_NOT_APPEAR"
FALLBACK_SENTINEL = "SYNTHETIC_FALLBACK_EXCEPTION_MUST_NOT_APPEAR"


@pytest.fixture(autouse=True)
def no_provider_requests(monkeypatch):
    def fail_request(*args, **kwargs):
        pytest.fail("OCR route regressions must not contact a real provider")

    monkeypatch.setattr(ocr_llm.requests, "post", fail_request)


@pytest.fixture
def authenticated_ocr(client, db):
    with client.session_transaction() as session:
        session["logged_in"] = True
    pigment = Pigment(
        brand="OCR test", code="P001", purchase_code="PUR001", name="Test pigment",
        hex="#000000", color_family="其他", spec_value=15, spec_unit="ml", unit_price=80,
    )
    pigment.stock = Stock(quantity=10)
    db.session.add(pigment)
    db.session.commit()
    return client, pigment


def _summary():
    return {
        "pigments": [(p.id, p.code, p.purchase_code, p.unit_price, p.is_archived)
                     for p in Pigment.query.order_by(Pigment.id).all()],
        "stock": [(s.pigment_id, s.quantity) for s in Stock.query.order_by(Stock.pigment_id).all()],
        "transactions": Transaction.query.count(),
        "pending": PendingReview.query.count(),
    }


def _upload(client, tx_type):
    return client.post(
        f"/transactions/{tx_type}/ocr",
        data={"file": (io.BytesIO(b"synthetic-image-bytes"), "test.png")},
        content_type="multipart/form-data",
    )


def _raise(error):
    def failed(*args, **kwargs):
        raise error
    return failed


def _rows(pigment):
    return [{"raw": "PUR001 2.5 3.25", "pigment_id": pigment.id,
             "purchase_code": "PUR001", "quantity": 2.5, "unit_price": 3.25}]


@pytest.mark.parametrize("tx_type", ["in", "out"])
def test_missing_key_reason_survives_the_real_disabled_fallback(authenticated_ocr, monkeypatch, tx_type):
    client, _ = authenticated_ocr
    monkeypatch.setenv("BAILIAN_API_KEY", "")
    before = _summary()
    response = _upload(client, tx_type)
    body = html.unescape(response.get_data(as_text=True))

    assert response.status_code == 200
    assert str(ocr_llm.LLMOCRError("missing_key")) in body
    assert "alert-danger" in body
    assert 'id="ocrTable"' not in body
    assert _summary() == before


@pytest.mark.parametrize("tx_type", ["in", "out"])
@pytest.mark.parametrize("code,status", [("timeout", None), ("permission", 403),
    ("model_unavailable", 404), ("response_structure", None)])
def test_disabled_fallback_preserves_the_safe_llm_reason(authenticated_ocr, monkeypatch, tx_type, code, status):
    client, _ = authenticated_ocr
    error = ocr_llm.LLMOCRError(code, status=status)
    monkeypatch.setattr(ocr_llm, "parse_image_llm", _raise(error))
    before = _summary()
    response = _upload(client, tx_type)
    body = html.unescape(response.get_data(as_text=True))

    assert response.status_code == 200
    assert str(error) in body
    assert "alert-danger" in body
    assert 'id="ocrTable"' not in body
    assert _summary() == before


@pytest.mark.parametrize("tx_type", ["in", "out"])
@pytest.mark.parametrize("failure", ["unexpected", "legacy_provider_message", "ordinary_fallback_failure"])
def test_raw_provider_and_unexpected_errors_never_reach_html_or_logs(
    authenticated_ocr, monkeypatch, caplog, tx_type, failure,
):
    client, _ = authenticated_ocr
    monkeypatch.setenv("BAILIAN_API_KEY", SECRET_SENTINEL)
    raw = f"Bearer {SECRET_SENTINEL}; provider response: {PROVIDER_SENTINEL}"
    error = (ocr_llm.LLMOCRError(raw, status=502)
             if failure == "legacy_provider_message" else RuntimeError(raw))
    monkeypatch.setattr(ocr_llm, "parse_image_llm", _raise(error))
    if failure == "ordinary_fallback_failure":
        monkeypatch.setattr(ocr, "parse_image", _raise(RuntimeError(FALLBACK_SENTINEL)))
    caplog.set_level(logging.WARNING)
    before = _summary()
    response = _upload(client, tx_type)
    body = html.unescape(response.get_data(as_text=True))

    assert response.status_code == 200
    assert "alert-danger" in body
    assert 'id="ocrTable"' not in body
    for sentinel in (SECRET_SENTINEL, PROVIDER_SENTINEL, FALLBACK_SENTINEL):
        assert sentinel not in body
        assert sentinel not in caplog.text
    assert caplog.records, "failures should retain a safe diagnostic log"
    assert all(record.exc_info is None for record in caplog.records)
    assert _summary() == before


@pytest.mark.parametrize("tx_type", ["in", "out"])
def test_successful_fallback_still_renders_the_preview_without_changing_inventory(
    authenticated_ocr, monkeypatch, tx_type,
):
    client, pigment = authenticated_ocr
    monkeypatch.setattr(ocr_llm, "parse_image_llm", _raise(ocr_llm.LLMOCRError("timeout")))
    calls = []

    def fallback(image, lookup):
        calls.append((image, dict(lookup)))
        return _rows(pigment)

    monkeypatch.setattr(ocr, "parse_image", fallback)
    before = _summary()
    response = _upload(client, tx_type)
    body = response.get_data(as_text=True)

    assert response.status_code == 200
    assert 'id="ocrTable"' in body
    assert 'value="P001"' in body
    assert "alert-warning" in body
    assert "alert-danger" not in body
    if tx_type == "out":
        assert 'value="80.00"' in body  # Existing out-preview archive-price behavior.
    assert len(calls) == 1
    assert calls[0][0] == b"synthetic-image-bytes"
    assert calls[0][1]["pur001"] == pigment.id
    assert _summary() == before


@pytest.mark.parametrize("tx_type", ["in", "out"])
def test_local_backend_need_not_define_the_disabled_exception(
    authenticated_ocr, monkeypatch, tx_type,
):
    client, pigment = authenticated_ocr
    monkeypatch.delattr(ocr, "OCRDisabledError")
    monkeypatch.setattr(ocr_llm, "parse_image_llm", _raise(ocr_llm.LLMOCRError("timeout")))
    monkeypatch.setattr(ocr, "parse_image", lambda image, lookup: _rows(pigment))
    before = _summary()
    response = _upload(client, tx_type)
    body = response.get_data(as_text=True)

    assert response.status_code == 200
    assert 'id="ocrTable"' in body
    assert "alert-warning" in body
    assert "alert-danger" not in body
    assert _summary() == before


@pytest.mark.parametrize("tx_type", ["in", "out"])
@pytest.mark.parametrize("empty", [False, True])
def test_primary_success_including_empty_rows_never_invokes_fallback(
    authenticated_ocr, monkeypatch, tx_type, empty,
):
    client, pigment = authenticated_ocr
    monkeypatch.setattr(ocr_llm, "parse_image_llm", lambda image, lookup: [] if empty else _rows(pigment))

    def unexpected_fallback(*args, **kwargs):
        pytest.fail("successful primary OCR, including [], must not invoke fallback")

    monkeypatch.setattr(ocr, "parse_image", unexpected_fallback)
    before = _summary()
    response = _upload(client, tx_type)
    body = response.get_data(as_text=True)

    assert response.status_code == 200
    assert 'id="ocrTable"' in body
    assert f"共识别出 <strong>{0 if empty else 1}</strong> 行" in body
    assert "alert-warning" not in body
    assert "alert-danger" not in body
    assert _summary() == before
