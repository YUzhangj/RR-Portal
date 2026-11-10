"""Revoke grants/activity/company while a real API request awaits a loopback parser.
The final database transaction must reject and roll back the pending replacement.
"""
import concurrent.futures, json, os, secrets, shutil, socket, sqlite3, subprocess, tempfile, threading, time
import urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
DOTNET = os.environ.get("DOTNET_EXECUTABLE") or shutil.which("dotnet")
DLL = ROOT / "server/VoyagePlex.Api/bin/Debug/net8.0/VoyagePlex.Api.dll"

def run():
    assert DOTNET and DLL.is_file()
    with tempfile.TemporaryDirectory(prefix="voyageplex-permission-transaction-") as directory:
        owned = Path(directory); db = owned / "synthetic.db"
        entered = threading.Event(); release = threading.Event(); calls = []
        class Parser(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                    while True:
                        size = int(self.rfile.readline().strip(), 16)
                        if not size: self.rfile.readline(); break
                        self.rfile.read(size); self.rfile.read(2)
                else: self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.path == "/v1/inspection-mappings/parse":
                    calls.append(self.path); entered.set()
                    assert release.wait(15), "test did not release parser"
                    result = {"rows": [{"group_name": "PR1100-new", "product_code": "PR1100-REPLACEMENT", "note": "confirmed replacement"}]}
                else: result = {"configured": False, "items": []}
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(result).encode())
        parser = ThreadingHTTPServer(("127.0.0.1", 0), Parser)
        threading.Thread(target=parser.serve_forever, daemon=True).start()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0)); port = listener.getsockname()[1]
        base = f"http://127.0.0.1:{port}"; sessions = {}; password = secrets.token_urlsafe(20)
        def req(path, body=None, who="admin", method=None, expected=200, raw=None, content_type=None):
            headers = {"Cookie": sessions.get(who, "") + "; voyageplex_company=Xingxin"}
            if body is not None: raw = json.dumps(body).encode(); content_type = "application/json"
            if content_type: headers["Content-Type"] = content_type
            try: response = urllib.request.urlopen(urllib.request.Request(base + path, data=raw, headers=headers, method=method), timeout=20)
            except urllib.error.HTTPError as error: response = error
            data = response.read(); value = json.loads(data) if data else None
            for cookie in response.headers.get_all("Set-Cookie", []):
                if cookie.startswith("voyageplex_session="): sessions[who] = cookie.split(";", 1)[0]
            assert response.status == expected, (path, who, response.status, value)
            return value
        env = {"PATH": str(Path(DOTNET).parent) + ":/usr/bin:/bin", "HOME": directory,
            "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "ASPNETCORE_ENVIRONMENT": "Production", "ASPNETCORE_URLS": base,
            "ConnectionStrings__Default": f"Data Source={db}", "EmailParser__BaseUrl": f"http://127.0.0.1:{parser.server_port}", "Logging__LogLevel__Default": "Error"}
        with (owned / "api.log").open("wb") as log:
            api = subprocess.Popen([DOTNET, str(DLL)], cwd=owned, env=env, stdout=log, stderr=log)
            try:
                for _ in range(300):
                    assert api.poll() is None
                    try: req("/api/health"); break
                    except OSError: time.sleep(.1)
                else: raise AssertionError("API startup timeout")
                req("/api/auth/setup", {"username": "admin", "displayName": "PR1100 synthetic admin", "password": password}, expected=201)
                req("/api/auth/login", {"username": "admin", "password": password})
                writer = req("/api/users", {"username": "writer", "displayName": "PR1100 synthetic writer", "role": "supervisor", "companyAccess": "Xingxin", "pagePermissions": {"settings.inspection": "edit"}, "password": password}, expected=201)
                req("/api/inspection-mappings", {"groupName": "PR1100-original", "productCode": "PR1100-KEEP", "note": "original business value"}, expected=201)
                def snapshot():
                    with sqlite3.connect(db) as conn: return conn.execute("SELECT * FROM InspectionMappings ORDER BY Id").fetchall()
                original = snapshot()
                assert len(original) == 1
                standard = {"displayName": writer["displayName"], "role": "supervisor", "companyAccess": "Xingxin", "isActive": True, "pagePermissions": {"settings.inspection": "edit"}}
                boundary = "pr1100-transaction-file"
                multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\nPR1100-LOOPBACK-STUB-ONLY\r\n--{boundary}--\r\n').encode()
                def upload(expected):
                    return req("/api/inspection-mappings/import", who="writer", raw=multipart, content_type="multipart/form-data; boundary=" + boundary, expected=expected)
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    for name, change in [("grant revoked", {"pagePermissions": {"settings.inspection": "view"}}), ("account deactivated", {"isActive": False}), ("company changed", {"companyAccess": "Huadeng"}), ("role changed with retained page grant", {"role": "admin"})]:
                        req(f"/api/users/{writer['id']}", standard, method="PUT")
                        req("/api/auth/login", {"username": "writer", "password": password}, who="writer")
                        entered.clear(); release.clear()
                        result = executor.submit(upload, 403)
                        assert entered.wait(10), "request did not reach parser await"
                        req(f"/api/users/{writer['id']}", {**standard, **change}, method="PUT")
                        release.set(); result.result(timeout=15)
                        assert snapshot() == original, name + " changed original mappings"
                        print("PASS final transaction rejects " + name + " and rolls back pending table replacement")
                    req(f"/api/users/{writer['id']}", standard, method="PUT")
                    req("/api/auth/login", {"username": "writer", "password": password}, who="writer")
                    entered.clear(); release.set()
                    assert upload(200)["total"] == 1
                    current = req("/api/inspection-mappings")
                    assert len(current) == 1 and current[0]["productCode"] == "PR1100-REPLACEMENT"
                    assert len(calls) == 5
                    print("PASS unchanged grant permits the same parser/import workflow")
                print("Final-transaction live HTTP/SQLite cases passed: 5")
            finally:
                release.set()
                if api.poll() is None: api.terminate(); api.wait(timeout=15)
                parser.shutdown(); parser.server_close()

if __name__ == "__main__": run()
