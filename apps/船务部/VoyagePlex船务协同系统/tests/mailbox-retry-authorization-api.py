"""Real HTTP/SQLite revocation checks for shared and personal mailbox retries.
Only temporary synthetic mail, allowlisted environment and a loopback parser.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import json
import os
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DOTNET = os.environ.get("DOTNET_EXECUTABLE") or shutil.which("dotnet")
DLL = ROOT / "server/VoyagePlex.Api/bin/Debug/net8.0/VoyagePlex.Api.dll"
ADDRESS = "owner@example.invalid"
HOST = "imap.example.invalid"
AUTH = "synthetic-only"
DATE = "2026-10-13T00:00:00Z"
ENDPOINT = "/api/imports/email/mailbox/retry-failed"


def run():
    assert DOTNET
    passed = []
    with tempfile.TemporaryDirectory(prefix="voyageplex-retry-authorization-") as temp:
        owned = Path(temp); database = owned / "test.db"
        class Parser(BaseHTTPRequestHandler):
            change = None; calls = []
            def log_message(self, *args): pass
            def reply(self, body):
                raw = json.dumps(body).encode(); self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
            def do_GET(self): self.reply({"configured": False, "items": []})
            def do_POST(self):
                if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                    raw = b""
                    while True:
                        count = int(self.rfile.readline().strip(), 16)
                        if not count: self.rfile.readline(); break
                        raw += self.rfile.read(count); self.rfile.read(2)
                else: raw = self.rfile.read(int(self.headers["Content-Length"]))
                value = json.loads(raw)
                if self.path == "/v1/mailbox/poll": return self.reply({"configured": False, "items": []})
                assert self.path in ("/v1/mailbox/retry-shared", "/v1/mailbox/retry")
                type(self).calls.append(self.path)
                if type(self).change:
                    change = type(self).change; type(self).change = None; change()
                self.reply({"configured": True, "address": ADDRESS, "uid_validity": 7,
                    "items": [{"mailbox_uid": uid, "mailbox_received_at": DATE, "status": "parsed",
                               "fingerprint": f"fp-{uid}", "message": {"subject": "Synthetic", "sender": "vendor@example.invalid"},
                               "items": [], "fields": {}} for uid in value["selected_uids"]]})
        parser = ThreadingHTTPServer(("127.0.0.1", 0), Parser)
        threading.Thread(target=parser.serve_forever, daemon=True).start()
        with socket.socket() as sock: sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        session = ""
        def request(path, payload=None, company="Xingxin", owner=None, expected=200, method=None):
            nonlocal session
            raw = None if payload is None else json.dumps(payload).encode()
            headers = {"Cookie": f"{session}; voyageplex_company={company}; voyageplex_mail_owner={owner or ''}"}
            if raw is not None: headers["Content-Type"] = "application/json"
            try: response = urllib.request.urlopen(urllib.request.Request(base+path, data=raw, headers=headers, method=method), timeout=20)
            except urllib.error.HTTPError as error: response = error
            for cookie in response.headers.get_all("Set-Cookie", []):
                if cookie.startswith("voyageplex_session="): session = cookie.split(";", 1)[0]
            value = json.loads(response.read() or b"null")
            assert response.code == expected, (path, response.code, value)
            return value
        env = {"PATH": str(Path(DOTNET).resolve().parent)+":/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(owned),
               "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "ASPNETCORE_ENVIRONMENT": "Production", "ASPNETCORE_URLS": base,
               "ConnectionStrings__Default": f"Data Source={database}", "EmailParser__BaseUrl": f"http://127.0.0.1:{parser.server_port}",
               "Logging__LogLevel__Default": "Error", "VOYAGEPLEX_HUADENG_MAILBOXES_JSON": json.dumps([
                   {"username": "synthetic-owner", "address": ADDRESS, "authCode": AUTH, "host": HOST, "folder": "INBOX"}])}
        with (owned/"api.log").open("wb") as log:
            api = subprocess.Popen([DOTNET, str(DLL)], cwd=owned, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic()+30
                while time.monotonic() < deadline:
                    assert api.poll() is None
                    try: request("/api/health"); break
                    except (OSError, urllib.error.URLError): time.sleep(.1)
                else: raise AssertionError("Owned API did not start")
                password = secrets.token_urlsafe(24)
                request("/api/auth/setup", {"username": "synthetic-admin", "displayName": "Synthetic admin", "password": password}, expected=201)
                request("/api/auth/login", {"username": "synthetic-admin", "password": password})
                owner_id = request("/api/users", {"username": "synthetic-owner", "displayName": "Synthetic owner", "password": password,
                    "role": "shipping", "companyAccess": "Huadeng"}, expected=201)["id"]
                request(f"/api/users/{owner_id}", {"displayName": "Synthetic owner", "role": "shipping", "companyAccess": "Huadeng",
                    "mailboxAddress": ADDRESS}, method="PUT")
                def insert(db, table, supplied):
                    row = {key: (0 if kind == "INTEGER" else "2026-11-04 00:00:00" if key.endswith("At") else "")
                           for _, key, kind, required, default, primary in db.execute(f"PRAGMA table_info({table})")
                           if not primary and key not in supplied and required and default is None}
                    row.update(supplied)
                    return db.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})", list(row.values())).lastrowid
                identity = hashlib.sha256(json.dumps({"address": ADDRESS, "host": HOST, "folder": "INBOX"}, separators=(",", ":")).encode()).hexdigest().upper()
                with sqlite3.connect(database) as db:
                    db.execute("UPDATE MailSystemSettings SET SyncEnabled=0")
                    db.execute("DELETE FROM MailSyncStates")
                    for state_id in (1, 1000+owner_id):
                        insert(db, "MailSyncStates", {"Id": state_id, "Address": ADDRESS, "UidValidity": 7, "LastUid": 999,
                            "MailboxIdentity": identity if state_id != 1 else "", "ConfigurationKey": ""})
                def snapshot():
                    with sqlite3.connect(database) as db:
                        return {name: db.execute(f"SELECT * FROM {name} ORDER BY Id").fetchall()
                                for name in ("ImportEmailItems", "ImportBatches", "MailSyncStates", "MailContacts", "ShipmentTasks")}
                def actor_update(values):
                    with sqlite3.connect(database) as db: db.execute(f"UPDATE Users SET {values} WHERE Username='synthetic-admin'")
                uid = 11
                for company in ("Xingxin", "Huadeng"):
                    owner = owner_id if company == "Huadeng" else 0
                    for mutation in ("Role='shipping'", "IsActive=0"):
                        actor_update("Role='admin',IsActive=1")
                        with sqlite3.connect(database) as db:
                            batch = insert(db, "ImportBatches", {"Company": company, "MailOwnerId": owner, "Kind": "Email",
                                "Status": "PendingConfirmation", "FailedCount": 1, "TotalCount": 1})
                            key = f"Huadeng:{owner}:{identity}:{ADDRESS}:7:{uid}" if owner else f"{ADDRESS}:7:{uid}"
                            item = insert(db, "ImportEmailItems", {"ImportBatchId": batch, "Company": company, "MailOwnerId": owner,
                                "MailboxKey": key, "MailReceivedAt": DATE, "MailReceivedDate": "2026-10-13", "Fingerprint": f"fp-{uid}",
                                "Status": "failed", "HandlingStatus": "Pending", "HandlingOutcome": "", "TaskIdsJson": "[]", "ResultJson": "{}"})
                        before = snapshot(); calls = len(Parser.calls)
                        Parser.change = lambda mutation=mutation: actor_update(mutation)
                        value = request(ENDPOINT, {"itemIds": [item]}, company, owner, expected=403)
                        assert value == {"error": "只有管理员可以重试失败邮件"}
                        assert len(Parser.calls) == calls+1 and snapshot() == before
                        assert Parser.calls[-1] == ("/v1/mailbox/retry" if owner else "/v1/mailbox/retry-shared")
                        passed.append(company+" rejects "+mutation+" after parser call; all mail rows and cursors preserved")
                        actor_update("Role='admin',IsActive=1")
                        assert request(ENDPOINT, {"itemIds": [item]}, company, owner)["recovered"] == 1
                        assert snapshot()["MailSyncStates"] == before["MailSyncStates"]
                        passed.append(company+" authorized retry after denial succeeds without cursor changes")
                        uid += 1
                for line in passed: print("PASS", line)
                print(json.dumps({"passed": len(passed), "failed": 0, "skipped": 0, "allDataOwnedTempSQLite": True}))
            finally:
                api.terminate(); api.wait(timeout=15); parser.shutdown(); parser.server_close()


if __name__ == "__main__": run()
