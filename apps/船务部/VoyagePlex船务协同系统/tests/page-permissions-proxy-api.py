"""Real Next -> API and Next -> loopback parser/QC authorization regressions."""
import json, os, secrets, shutil, socket, sqlite3, subprocess, tempfile, threading, time
import urllib.error, urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
DOTNET = os.environ.get("DOTNET_EXECUTABLE") or shutil.which("dotnet")
NODE = os.environ.get("NODE_EXECUTABLE") or shutil.which("node")
DLL = ROOT / "server/VoyagePlex.Api/bin/Debug/net8.0/VoyagePlex.Api.dll"

def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]

def run():
    assert DOTNET and NODE and DLL.is_file()
    assert (ROOT / ".next-build/BUILD_ID").is_file(), "Build the production web before testing"
    with tempfile.TemporaryDirectory(prefix="voyageplex-page-proxy-") as directory:
        owned = Path(directory)
        db = owned / "synthetic.db"
        api_base = f"http://127.0.0.1:{free_port()}"
        web_port = free_port()
        web_base = f"http://127.0.0.1:{web_port}"
        password = secrets.token_urlsafe(20)
        key = secrets.token_urlsafe(20)
        calls = []
        processes = []
        logs = []
        sessions = {}
        class Stub(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                    chunks = []
                    while True:
                        size = int(self.rfile.readline().strip(), 16)
                        if not size:
                            self.rfile.readline(); break
                        chunks.append(self.rfile.read(size)); self.rfile.read(2)
                    raw = b"".join(chunks)
                else:
                    raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                calls.append(self.path)
                if self.path == "/v1/local-inventory-files/scan":
                    result = {"rows": [], "files": [], "synthetic": True}
                elif self.path == "/qc/batch":
                    assert self.headers.get("Authorization") == "Bearer " + key
                    result = {"results": [{"itemIndex": i, "total": 0, "latest": None} for i, _ in enumerate(json.loads(raw)["items"])]}
                elif self.path.startswith("/v1/mailbox"):
                    result = {"configured": False, "items": []}
                else:
                    self.send_response(500); self.end_headers(); return
                data = json.dumps(result).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(data)
        stub = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=stub.serve_forever, daemon=True).start()
        stub_base = f"http://127.0.0.1:{stub.server_port}"
        def request(path, body=None, who="admin", expected=200, method=None, company="Xingxin", raw=None, content_type=None, base=web_base):
            headers = {"Cookie": sessions.get(who, "") + "; voyageplex_company=" + company}
            if body is not None:
                raw = json.dumps(body).encode(); content_type = "application/json"
            if content_type: headers["Content-Type"] = content_type
            try:
                response = urllib.request.urlopen(urllib.request.Request(base + path, data=raw, headers=headers, method=method), timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            data = response.read()
            value = json.loads(data) if data else None
            for cookie in response.headers.get_all("Set-Cookie", []):
                if cookie.startswith("voyageplex_session="):
                    sessions[who] = cookie.split(";", 1)[0]
            assert response.status == expected, (path, who, response.status, value)
            return value
        def wait(base):
            for _ in range(300):
                assert all(p.poll() is None for p in processes), "isolated service exited"
                try:
                    request("/api/auth/setup-status", base=base); return
                except OSError:
                    time.sleep(.1)
            raise AssertionError("startup timeout")
        def start(command, cwd, additions, name):
            env = {"PATH": str(Path(NODE).parent) + ":" + str(Path(DOTNET).parent) + ":/usr/bin:/bin", "HOME": directory,
                "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "NEXT_TELEMETRY_DISABLED": "1", "ASPNETCORE_ENVIRONMENT": "Production",
                "EmailParser__BaseUrl": stub_base, "EMAIL_PARSER_BASE_URL": stub_base, **additions}
            log = (owned / (name + ".log")).open("wb"); logs.append(log)
            process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=log); processes.append(process)
        try:
            start([DOTNET, str(DLL)], owned, {"ASPNETCORE_URLS": api_base, "ConnectionStrings__Default": f"Data Source={db}", "Logging__LogLevel__Default": "Error"}, "api")
            wait(api_base)
            start([NODE, str(ROOT / "node_modules/next/dist/bin/next"), "start", "--port", str(web_port), "--hostname", "127.0.0.1"], ROOT,
                {"VOYAGEPLEX_API_BASE_URL": api_base, "NEXT_DIST_DIR": ".next-build", "QC_SYSTEM_API_URL": stub_base + "/qc", "QC_SYSTEM_API_TOKEN": key}, "web")
            wait(web_base)
            request("/api/auth/setup", {"username": "admin", "displayName": "PR1100 proxy admin", "password": password}, expected=201)
            request("/api/auth/login", {"username": "admin", "password": password})
            def create(name, role, grants):
                return request("/api/users", {"username": name, "displayName": "PR1100 " + name, "role": role,
                    "companyAccess": "Xingxin", "password": password, "pagePermissions": grants}, expected=201)
            def update(user, grants):
                request(f"/api/users/{user['id']}", {"displayName": user["displayName"], "role": user["role"], "companyAccess": "Xingxin", "isActive": True, "pagePermissions": grants}, method="PUT")
            inventory = create("inventoryreader", "warehouse", {"inventory": "view"})
            shipment = create("shipmentreader", "shipping", {"shipments": "view"})
            for name in ["inventoryreader", "shipmentreader"]:
                request("/api/auth/login", {"username": name, "password": password}, who=name)
            boundary = "pr1100syntheticboundary"
            multipart = ("--" + boundary + "--\r\n").encode()
            def scan(expected):
                return request("/api/inventory/local-files/scan", who="inventoryreader", raw=multipart,
                    content_type="multipart/form-data; boundary=" + boundary, expected=expected)
            assert scan(200)["synthetic"] is True
            before = calls.count("/v1/local-inventory-files/scan")
            request("/api/inventory/local-files/writeback", who="inventoryreader", raw=multipart,
                content_type="multipart/form-data; boundary=" + boundary, expected=403)
            assert "/v1/local-inventory-files/writeback" not in calls
            update(inventory, {})
            scan(403)
            assert calls.count("/v1/local-inventory-files/scan") == before
            update(inventory, {"inventory": "view"})
            assert scan(200)["synthetic"] is True
            before_qc = calls.count("/qc/batch")
            query = {"items": [{"contractNumber": "PR1100-C", "customerPo": "", "itemNumber": "PR1100-I"}]}
            assert request("/api/qc/results", query, who="shipmentreader")["results"][0]["total"] == 0
            assert calls.count("/qc/batch") == before_qc + 1
            request("/api/shipments", {"customer": "forbidden"}, who="shipmentreader", expected=403)
            update(shipment, {})
            request("/api/qc/results", query, who="shipmentreader", expected=403)
            request("/api/qc/results", query, who="shipmentreader", company="Huadeng", expected=403)
            assert calls.count("/qc/batch") == before_qc + 1
            with sqlite3.connect(db) as conn:
                assert conn.execute("SELECT COUNT(*) FROM ShipmentTasks").fetchone()[0] == 0
                assert conn.execute("SELECT COUNT(*) FROM InventoryWritebacks").fetchone()[0] == 0
            print("Permission proxy live HTTP passed: Next login/user grant, read-only inventory scan, denied writeback with no parser call, immediate revoke/regrant, QC read-only lookup/revoke/company scope, zero business writes.")
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate(); process.wait(timeout=15)
            for log in logs: log.close()
            stub.shutdown(); stub.server_close()

if __name__ == "__main__":
    run()
