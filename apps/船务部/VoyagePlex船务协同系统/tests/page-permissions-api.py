"""End-to-end page grants against an isolated API and temporary SQLite database."""
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
    with tempfile.TemporaryDirectory(prefix="voyageplex-permissions-") as folder:
        owned = Path(folder)
        db = owned / "test.db"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        sessions = {}
        def request(path, data=None, *, who="admin", method=None, company="Xingxin", expected=200):
            headers = {"Cookie": f"{sessions.get(who, '')}; voyageplex_company={company}"}
            raw = None if data is None else json.dumps(data).encode()
            if raw is not None: headers["Content-Type"] = "application/json"
            try: response = urllib.request.urlopen(urllib.request.Request(base + path, data=raw, headers=headers, method=method), timeout=10)
            except urllib.error.HTTPError as error: response = error
            for cookie in response.headers.get_all("Set-Cookie", []):
                if cookie.startswith("voyageplex_session="): sessions[who] = cookie.split(";", 1)[0]
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
                    try: request("/api/health"); break
                    except (OSError, urllib.error.URLError): time.sleep(.1)
                else: raise AssertionError("API did not start")
                password = secrets.token_urlsafe(18)
                request("/api/auth/setup", {"username":"admin", "displayName":"Admin", "password":password}, expected=201)
                request("/api/auth/login", {"username":"admin", "password":password})
                def create(name, role, grants=None):
                    data = {"username":name, "displayName":name, "password":password, "role":role, "companyAccess":"Xingxin"}
                    if grants is not None: data["pagePermissions"] = grants
                    return request("/api/users", data, expected=201)
                def login(name): request("/api/auth/login", {"username":name, "password":password}, who=name)
                def update(user, grants):
                    return request(f"/api/users/{user['id']}", {"displayName":user["displayName"], "role":user["role"], "companyAccess":"Xingxin", "pagePermissions":grants}, method="PUT")
                legacy = create("legacy", "shipping")
                assert legacy["pagePermissions"]["shipments"] == "edit"
                login("legacy"); request("/api/shipments", who="legacy")
                reader = create("reader", "shipping", {"shipments":"view", "mail.contacts":"view"})
                login("reader")
                request("/api/shipments", who="reader")
                request("/api/shipments", {"customer":"test"}, who="reader", expected=403)
                request("/api/mail/contacts", who="reader")
                request("/api/mail/contacts/1", {"displayName":"test"}, who="reader", method="PATCH", expected=403)
                request("/api/mail/dates", who="reader", expected=403)
                request("/api/imports/email", {}, who="reader", expected=403)
                request("/api/shipments", who="reader", company="Huadeng", expected=403)
                update(reader, {"mail.contacts":"view"})
                request("/api/shipments", who="reader", expected=403)
                request("/api/mail/contacts", who="reader")
                request("/api/users", {"username":"invalid", "displayName":"invalid", "password":password, "role":"shipping", "companyAccess":"Xingxin", "pagePermissions":{"inventory":"edit"}}, expected=400)
                supervisor = create("supervisor", "supervisor", {"users":"edit", "shipments":"view"})
                login("supervisor")
                request("/api/users", {"username":"elevated", "displayName":"elevated", "password":password, "role":"shipping", "companyAccess":"Xingxin", "pagePermissions":{"shipments":"edit"}}, who="supervisor", expected=400)
                request("/api/users", {"username":"limited", "displayName":"limited", "password":password, "role":"shipping", "companyAccess":"Xingxin", "pagePermissions":{"shipments":"view"}}, who="supervisor", expected=201)
                with sqlite3.connect(db) as connection:
                    connection.execute("UPDATE Users SET PagePermissionsJson = ? WHERE Id = ?", ("{broken", reader["id"]))
                request("/api/mail/contacts", who="reader", expected=403)
                # Simulate a pre-feature database: preserve users and sessions while removing the new column.
                api.terminate(); api.wait(timeout=15)
                with sqlite3.connect(db) as connection:
                    connection.execute("ALTER TABLE Users DROP COLUMN PagePermissionsJson")
                api = subprocess.Popen([DOTNET, str(DLL)], cwd=owned, env=env, stdout=log, stderr=log)
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    assert api.poll() is None
                    try: request("/api/health"); break
                    except (OSError, urllib.error.URLError): time.sleep(.1)
                else: raise AssertionError("API did not restart after legacy schema")
                assert request("/api/auth/me", who="legacy")["pagePermissions"]["shipments"] == "edit"
                request("/api/shipments", who="legacy")
                print("PASS: role defaults, page view/edit, revocation, company isolation, invalid grants, delegation limits, invalid stored data, and legacy database migration")
            finally:
                api.terminate(); api.wait(timeout=15)

if __name__ == "__main__": run()
