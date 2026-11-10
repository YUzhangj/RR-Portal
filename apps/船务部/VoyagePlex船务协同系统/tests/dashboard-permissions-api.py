"""Synthetic HTTP regression: home access must not expose raw shipment/mail records."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DOTNET = os.environ.get("DOTNET_EXECUTABLE") or shutil.which("dotnet")
DLL = ROOT / "server/VoyagePlex.Api/bin/Debug/net8.0/VoyagePlex.Api.dll"


def run():
    assert DOTNET
    with tempfile.TemporaryDirectory(prefix="voyageplex-dashboard-permissions-") as folder:
        owned = Path(folder)
        db = owned / "test.db"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        sessions = {}

        def request(path, data=None, *, who="admin", method=None, company="Xingxin", expected=200):
            headers = {"Cookie": f"{sessions.get(who, '')}; voyageplex_company={company}"}
            raw = None if data is None else json.dumps(data).encode()
            if raw is not None:
                headers["Content-Type"] = "application/json"
            try:
                response = urllib.request.urlopen(urllib.request.Request(base + path, data=raw, headers=headers, method=method), timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            for cookie in response.headers.get_all("Set-Cookie", []):
                if cookie.startswith("voyageplex_session="):
                    sessions[who] = cookie.split(";", 1)[0]
            body = response.read()
            value = json.loads(body) if body else None
            assert response.status == expected, (path, response.status, value, expected)
            return value

        env = {"PATH": str(Path(DOTNET).resolve().parent) + ":/usr/bin:/bin", "HOME": folder,
               "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "ASPNETCORE_ENVIRONMENT": "Production", "ASPNETCORE_URLS": base,
               "ConnectionStrings__Default": f"Data Source={db}", "EmailParser__BaseUrl": "http://127.0.0.1:9", "Logging__LogLevel__Default": "Error"}
        with (owned / "api.log").open("wb") as log:
            api = subprocess.Popen([DOTNET, str(DLL)], cwd=owned, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    assert api.poll() is None
                    try:
                        request("/api/health")
                        break
                    except (OSError, urllib.error.URLError):
                        time.sleep(.1)
                else:
                    raise AssertionError("API did not start")
                password = secrets.token_urlsafe(18)
                request("/api/auth/setup", {"username": "admin", "displayName": "Synthetic Admin", "password": password}, expected=201)
                request("/api/auth/login", {"username": "admin", "password": password})
                for name, role, grants in [
                    ("homeonly", "shipping", {"home": "view"}),
                    ("taskreader", "shipping", {"shipments": "view"}),
                    ("warehousehome", "warehouse", {"home": "view"}),
                    ("inventoryreader", "warehouse", {"inventory": "view"}),
                    ("denied", "shipping", {}),
                ]:
                    request("/api/users", {"username": name, "displayName": name, "password": password, "role": role,
                                          "companyAccess": "Xingxin", "pagePermissions": grants}, expected=201)
                    request("/api/auth/login", {"username": name, "password": password}, who=name)
                first = request("/api/shipments", {"customer": "SYN-HOME-FIRST", "soNumber": "SYN-SO-1", "plannedShipDate": "2030-01-02", "containerType": "40HQ"}, expected=201)
                second = request("/api/shipments", {"customer": "SYN-HOME-SECOND", "soNumber": "SYN-SO-2", "plannedShipDate": "2030-01-03"}, expected=201)
                foreign = request("/api/shipments", {"customer": "SYN-HUADENG-HIDDEN"}, company="Huadeng", expected=201)
                marker = "SYN-PRIVATE-CARGO-MAIL"
                with sqlite3.connect(db) as connection:
                    for task, status, items in [
                        (first, "PendingReview", [{"product_code": marker, "inspection_result": "未通过", "quantity": 10, "inventory_quantity": 3}]),
                        (second, "PendingShipment", [{"product_code": marker, "inspection_result": "PASS", "qc_result": "FAIL", "quantity": "10", "inventory_quantity": "10"}]),
                    ]:
                        connection.execute("UPDATE ShipmentTasks SET Status=?, ItemsJson=?, ExportDetailsJson=?, SourceEmailsJson=?, EmailSubject=?, SourceMailboxAddress=?, SpecialRequirements=? WHERE Id=?",
                                           (status, json.dumps(items), json.dumps({"private": marker}), json.dumps([{"mailSubject": marker}]), marker, marker, marker, task["id"]))

                def shipment_snapshot():
                    with sqlite3.connect(db) as connection:
                        rows = connection.execute("SELECT * FROM ShipmentTasks ORDER BY Id").fetchall()
                    return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()

                before = shipment_snapshot()
                expected_keys = {"id", "customer", "soNumber", "containerType", "plannedShipDate", "status", "createdAt", "updatedAt", "inspectionFailed", "inventoryShortage"}
                projected = request("/api/shipments", who="homeonly")
                assert {row["id"] for row in projected} == {first["id"], second["id"]}
                assert all(set(row) == expected_keys for row in projected)
                assert marker not in json.dumps(projected)
                first_summary = next(row for row in projected if row["id"] == first["id"])
                second_summary = next(row for row in projected if row["id"] == second["id"])
                assert first_summary["inspectionFailed"] and first_summary["inventoryShortage"]
                assert not second_summary["inspectionFailed"] and not second_summary["inventoryShortage"]
                assert first_summary["plannedShipDate"] == "2030-01-02" and first_summary["containerType"] == "40HQ"
                # Searching home data cannot become an oracle for hidden cargo text.
                assert request("/api/shipments?query=" + marker, who="homeonly") == []
                assert len(request("/api/shipments?query=SYN-HOME-FIRST", who="homeonly")) == 1
                request(f"/api/shipments/{first['id']}", who="homeonly", expected=403)
                request("/api/shipments", who="homeonly", company="Huadeng", expected=403)
                request("/api/shipments", who="denied", expected=403)
                full = request("/api/shipments", who="taskreader")
                assert marker in json.dumps(full) and all("items" in row and "exportDetails" in row for row in full)
                warehouse_summary = request("/api/shipments", who="warehousehome")
                assert [row["id"] for row in warehouse_summary] == [second["id"]]
                assert all(set(row) == expected_keys for row in warehouse_summary)
                warehouse_full = request("/api/shipments", who="inventoryreader")
                assert [row["id"] for row in warehouse_full] == [second["id"]] and marker in json.dumps(warehouse_full)
                assert foreign["id"] not in {row["id"] for row in full}
                assert shipment_snapshot() == before, "Dashboard reads changed business records"
                print("PASS: home-only minimal projection, anomaly parity, no hidden-field search oracle, full-reader compatibility, company/warehouse scopes, denied detail and unchanged business rows")
            finally:
                api.terminate()
                api.wait(timeout=15)


if __name__ == "__main__":
    run()
