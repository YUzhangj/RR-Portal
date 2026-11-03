"""Actual loopback API + disposable SQLite regression; no IMAP or parser calls."""
import copy
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DLL = ROOT / "server/VoyagePlex.Api/bin/Debug/net8.0/VoyagePlex.Api.dll"


def run():
    with tempfile.TemporaryDirectory(prefix="voyageplex-truck-api-") as temp:
        temp = Path(temp)
        db_path = temp / "synthetic.db"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

        def request(path, payload=None, expected=200):
            body = None if payload is None else json.dumps(payload).encode()
            try:
                response = opener.open(urllib.request.Request(base + path, data=body, headers={"Content-Type": "application/json"}), timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            raw = response.read()
            value = json.loads(raw) if raw else None
            assert response.code == expected, (path, response.code)
            return value

        def snapshot():
            with sqlite3.connect(db_path) as db:
                return {name: db.execute(f'SELECT * FROM "{name}" ORDER BY Id').fetchall() for name in
                        ("ImportBatches", "ImportEmailItems", "ShipmentTasks", "ProductNameMappings")}

        def insert(db, table, values):
            fields = {}
            for _, name, kind, required, default, primary in db.execute(f'PRAGMA table_info("{table}")'):
                if not primary and name not in values and required and default is None:
                    fields[name] = 0 if kind == "INTEGER" else "2026-10-19 00:00:00" if name.endswith("At") else ""
            fields.update(values)
            return db.execute(f'INSERT INTO "{table}" ({",".join(fields)}) VALUES ({",".join("?" for _ in fields)})', list(fields.values())).lastrowid

        env = {key: value for key, value in os.environ.items() if not key.startswith("VOYAGEPLEX_")}
        env.update(ConnectionStrings__Default=f"Data Source={db_path}", ASPNETCORE_URLS=base,
                   EmailParser__BaseUrl="http://127.0.0.1:9", DOTNET_CLI_TELEMETRY_OPTOUT="1")
        with (temp / "api.log").open("wb") as log:
            process = subprocess.Popen([os.environ.get("DOTNET_BINARY", "dotnet"), str(DLL)], cwd=ROOT / "server/VoyagePlex.Api", env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 30
                while True:
                    assert process.poll() is None, "Synthetic API exited"
                    try:
                        request("/api/auth/setup-status")
                        break
                    except OSError:
                        assert time.monotonic() < deadline, "Synthetic API did not start"
                        time.sleep(0.05)
                password = secrets.token_urlsafe(20)
                request("/api/auth/setup", {"username": "trucktest", "displayName": "Synthetic", "password": password}, 201)
                request("/api/auth/login", {"username": "trucktest", "password": password})
                source = {"status": "parsed", "fingerprint": "synthetic-mixed-truck", "fields": {"customer": "Synthetic", "shipment_mode": "Warehouse"},
                          "items": [{"product_code": "A", "quantity": 100, "pieces": 10, "volume": 20, "pallet_count": 2, "net_weight": 3, "packing_group": "M", "source_file": "synthetic.xlsx"},
                                    {"product_code": "B", "quantity": 50, "pieces": None, "volume": None, "pallet_count": None, "net_weight": 4, "packing_group": "M", "source_file": "synthetic.xlsx"}],
                          "warehouse_trip_plan": {"confirmed": True, "trips": [{"key": "one", "warehouse": "裕泰仓", "vehicle_type": "1*8T", "allocations": [
                              {"item_index": 0, "quantity": "100", "pieces": "10", "volume": "20", "pallet_count": "2"},
                              {"item_index": 1, "quantity": "50", "pieces": "", "volume": "", "pallet_count": ""}]}]}}
                ids = request("/api/imports/email/confirm", {"items": [source]})["shipment_task_ids"]
                assert len(ids) == 1
                items = request(f"/api/shipments/{ids[0]}")["items"]
                assert [row["quantity"] for row in items] == [100, 50]
                assert items[1]["pieces"] is None and items[1]["volume"] is None and items[1]["net_weight"] == 4
                bad = copy.deepcopy(source)
                bad["items"][1]["pieces"] = 15
                bad["warehouse_trip_plan"]["trips"][0]["allocations"][1]["pieces"] = "15"
                before = snapshot()
                request("/api/imports/email/confirm", {"items": [source, bad]}, 400)
                assert snapshot() == before, "Invalid mixed group must not partially persist any batch rows"
                gross_bad = copy.deepcopy(source)
                gross_bad["items"][0]["gross_weight"] = 25.2
                gross_bad["items"][1]["gross_weight"] = 99
                scopes_bad = copy.deepcopy(source)
                scopes_bad["fields"]["cargo_split_required"] = "true"
                scopes_bad["items"][0]["shipment_scope"] = "current"
                scopes_bad["items"][1]["shipment_scope"] = "waiting"
                for invalid in (gross_bad, scopes_bad):
                    before = snapshot()
                    request("/api/imports/email/confirm", {"items": [invalid]}, 400)
                    assert snapshot() == before, "Invalid shared source data must not persist task or batch rows"
                reordered = copy.deepcopy(source)
                reordered["fingerprint"] = "synthetic-reordered-mixed-truck"
                reordered["items"].append({"product_code": "PLAIN", "quantity": 1, "pieces": 1, "volume": 1})
                reordered["warehouse_trip_plan"]["trips"][0]["allocations"].insert(1, {"item_index": 2, "quantity": "1", "pieces": "1", "volume": "1"})
                ordered_id = request("/api/imports/email/confirm", {"items": [reordered]})["shipment_task_ids"][0]
                assert [row["product_code"] for row in request(f"/api/shipments/{ordered_id}")["items"]] == ["A", "B", "PLAIN"]
                with sqlite3.connect(db_path) as db:
                    batch_id = insert(db, "ImportBatches", {"Company": "Xingxin", "Kind": "Email", "Status": "PendingConfirmation"})
                    stored = copy.deepcopy(source)
                    stored["fingerprint"] = "synthetic-stored-mixed-truck"
                    item_id = insert(db, "ImportEmailItems", {"Company": "Xingxin", "ImportBatchId": batch_id, "Status": "pending", "ResultJson": json.dumps(stored)})
                stored["import_item_id"] = item_id
                invalid_stored = copy.deepcopy(stored)
                invalid_stored["warehouse_trip_plan"]["trips"][0]["allocations"][1]["pieces"] = "15"
                before = snapshot()
                request(f"/api/imports/email/{batch_id}/confirm", {"items": [invalid_stored]}, 400)
                assert snapshot() == before, "Stored-batch rejection must preserve all typed rows"
                stored_ids = request(f"/api/imports/email/{batch_id}/confirm", {"items": [stored]})["shipment_task_ids"]
                assert len(stored_ids) == 1 and stored_ids != ids
                print("Mixed-packing API: sparse shared values, per-SKU quantity/net weight and both confirmation routes/rollback passed.")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    run()
