"""Live HTTP/SQLite authorization regressions. Synthetic temp DB; loopback only."""
import json, os, secrets, shutil, socket, sqlite3, subprocess, tempfile, time
import urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOTNET = os.environ.get("DOTNET_EXECUTABLE") or shutil.which("dotnet")
DLL = ROOT / "server/VoyagePlex.Api/bin/Debug/net8.0/VoyagePlex.Api.dll"


def run():
    assert DOTNET and DLL.is_file(), "Build the isolated API before testing"
    checked = []
    with tempfile.TemporaryDirectory(prefix="voyageplex-permission-boundaries-") as directory:
        owned = Path(directory)
        db = owned / "synthetic.db"
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        password = secrets.token_urlsafe(20)
        replacement = secrets.token_urlsafe(20)
        sessions = {}
        process = None
        log = None

        def request(path, body=None, who="admin", method=None, expected=200, company="Xingxin"):
            headers = {"Cookie": sessions.get(who, "") + "; voyageplex_company=" + company}
            data = None if body is None else json.dumps(body).encode()
            if data is not None:
                headers["Content-Type"] = "application/json"
            try:
                response = urllib.request.urlopen(urllib.request.Request(base + path, data=data, headers=headers, method=method), timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            raw = response.read()
            value = json.loads(raw) if raw else None
            for cookie in response.headers.get_all("Set-Cookie", []):
                if cookie.startswith("voyageplex_session="):
                    sessions[who] = cookie.split(";", 1)[0]
            allowed = expected if isinstance(expected, tuple) else (expected,)
            assert response.status in allowed, (path, who, response.status, value)
            return value

        def start():
            nonlocal process, log
            env = {"PATH": str(Path(DOTNET).resolve().parent) + ":/usr/bin:/bin", "HOME": directory,
                   "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "ASPNETCORE_ENVIRONMENT": "Production",
                   "ASPNETCORE_URLS": base, "ConnectionStrings__Default": f"Data Source={db}",
                   "EmailParser__BaseUrl": "http://127.0.0.1:9", "Logging__LogLevel__Default": "Error"}
            log = (owned / "api.log").open("ab")
            process = subprocess.Popen([DOTNET, str(DLL)], cwd=owned, env=env, stdout=log, stderr=log)
            for _ in range(300):
                assert process.poll() is None, "isolated API exited"
                try:
                    request("/api/health")
                    return
                except OSError:
                    time.sleep(.1)
            raise AssertionError("API startup timeout")

        def stop():
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=15)
            if log is not None:
                log.close()

        def create(name, role="shipping", grants=None):
            return request("/api/users", {"username": name, "displayName": "PR1100 Synthetic " + name,
                "role": role, "companyAccess": "Xingxin", "password": password,
                "pagePermissions": grants or {}}, expected=201)

        def login(name, supplied=None, expected=200):
            return request("/api/auth/login", {"username": name, "password": supplied or password}, who=name, expected=expected)

        def update(user, grants):
            return request(f"/api/users/{user['id']}", {"displayName": user["displayName"], "role": user["role"],
                "companyAccess": "Xingxin", "isActive": True, "pagePermissions": grants}, method="PUT")

        def row(user_id):
            with sqlite3.connect(db) as conn:
                return conn.execute("SELECT Username,DisplayName,Role,CompanyAccess,PasswordHash,PagePermissionsJson,IsActive FROM Users WHERE Id=?", (user_id,)).fetchone()

        try:
            start()
            request("/api/auth/setup", {"username": "admin", "displayName": "PR1100 Synthetic Admin", "password": password}, expected=201)
            login("admin")
            limited = create("limited", "supervisor", {"users": "edit"})
            target = create("target", grants={"shipments": "edit"})
            lower = create("lower")
            reader = create("reader", grants={"shipments": "view"})
            template = create("template", grants={"settings.templates": "view"})
            workbench = create("workbench", grants={"mail.workbench": "edit"})
            for name in ["limited", "target", "reader", "template", "workbench"]:
                login(name)

            # A restricted manager cannot take over a stronger identity by resetting its password.
            before = row(target["id"])
            request(f"/api/users/{target['id']}/reset-password", {"password": replacement}, who="limited", expected=(400, 403))
            assert row(target["id"]) == before
            login("target", replacement, expected=401)
            login("target")
            request("/api/shipments", who="limited", expected=403)
            checked.append("higher-privilege password reset denied without mutation")

            # Editing profile or reducing requested grants must not bypass the target ceiling.
            target_body = {"displayName": target["displayName"], "role": target["role"], "companyAccess": "Xingxin", "isActive": True}
            for payload in [target_body, {**target_body, "pagePermissions": {}}, {**target_body, "role": "warehouse", "pagePermissions": {}}]:
                request(f"/api/users/{target['id']}", payload, who="limited", method="PUT", expected=403)
                assert row(target["id"]) == before
            request(f"/api/users/{target['id']}/mailbox-test", {}, who="limited", expected=403)
            request(f"/api/users/{target['id']}", {**target_body, "isActive": False}, method="PUT")
            disabled = row(target["id"])
            assert disabled[-1] == 0
            request(f"/api/users/{target['id']}", target_body, who="limited", method="PUT", expected=403)
            assert row(target["id"]) == disabled
            request(f"/api/users/{target['id']}", target_body, method="PUT")
            stop()
            start()
            request(f"/api/users/{target['id']}/reset-password", {"password": replacement}, who="limited", expected=403)
            request(f"/api/users/{target['id']}", {**target_body, "pagePermissions": {}}, who="limited", method="PUT", expected=403)
            assert row(target["id"]) == before
            checked.append("strong-target profile/grant/role changes, mailbox test and re-enable denied across restart")

            # Equivalent user routes must retain role/company caps, including a trailing slash.
            for suffix, endpoint in [("canonical", "/api/users"), ("trailing", "/api/users/"), ("case", "/API/USERS/")]:
                name = "escalation_" + suffix
                request(endpoint, {"username": name, "displayName": "PR1100 forbidden", "password": password,
                    "role": "admin", "companyAccess": "Both", "pagePermissions": {}}, who="limited", expected=(400, 403))
                with sqlite3.connect(db) as conn:
                    assert conn.execute("SELECT COUNT(*) FROM Users WHERE Username=?", (name,)).fetchone()[0] == 0
            checked.append("canonical, slash and case aliases cannot create admin")

            # Legitimate scoped management still works and invalidates the target's prior session.
            login("lower")
            request(f"/api/users/{lower['id']}/reset-password", {"password": replacement}, who="limited", expected=204)
            request("/api/auth/me", who="lower", expected=401)
            login("lower", replacement)
            checked.append("same-scope reset works and invalidates prior sessions")

            # Grant changes apply to the existing session immediately and survive a restart.
            request("/api/shipments", who="reader")
            request("/api/shipments", {"customer": "PR1100 view-only blocked"}, who="reader", expected=403)
            update(reader, {"shipments": "edit"})
            task = request("/api/shipments", {"customer": "PR1100 saved synthetic", "plannedShipDate": "2026-11-10"}, who="reader", expected=201)
            task_id = task["id"]
            request(f"/api/shipments/{task_id}", {"transportReference": "PR1100 retained"}, who="reader", method="PATCH")
            update(reader, {"shipments": "view"})
            assert request(f"/api/shipments/{task_id}", who="reader")["transportReference"] == "PR1100 retained"
            request(f"/api/shipments/{task_id}", {"transportReference": "forbidden"}, who="reader", method="PATCH", expected=403)
            request(f"/api/shipments/{task_id}", who="reader", method="DELETE", expected=403)
            request(f"/api/shipments/{task_id}/export", who="reader", expected=403)
            stop()
            start()
            assert request("/api/auth/me", who="reader")["pagePermissions"]["shipments"] == "view"
            assert request(f"/api/shipments/{task_id}", who="reader")["transportReference"] == "PR1100 retained"
            update(reader, {})
            request("/api/shipments", who="reader", expected=403)
            request(f"/api/shipments/{task_id}", who="reader", expected=403)
            assert request("/api/auth/me", who="reader")["pagePermissions"]["shipments"] == "none"
            checked.append("grant, downgrade, revoke and restart preserve data and enforce old sessions")

            # View-only template browsing is not an export; write routes remain forbidden.
            request("/api/export-templates", who="template")
            request("/api/export-templates", {}, who="template", expected=403)
            checked.append("template view allowed while template mutation forbidden")

            # Existing workbench flow needs split preview without granting manual import.
            response = request("/api/imports/email/split-preview", {"items": []}, who="workbench", expected=(200, 400))
            request("/api/imports/email", {}, who="workbench", expected=403)
            request("/api/shipments", who="workbench", company="Huadeng", expected=403)
            checked.append("workbench preview usable without unrelated import or company access")

            with sqlite3.connect(db) as conn:
                assert conn.execute("SELECT COUNT(*) FROM ShipmentTasks").fetchone()[0] == 1
                assert conn.execute("SELECT TransportReference FROM ShipmentTasks WHERE Id=?", (task_id,)).fetchone()[0] == "PR1100 retained"
            # Last-admin protection remains effective after adding final-transaction grant checks.
            admin = request("/api/auth/me")
            admin_before = row(admin["id"])
            request(f"/api/users/{admin['id']}", {"displayName": admin["displayName"], "role": "shipping", "companyAccess": "Xingxin", "isActive": True, "pagePermissions": {}}, method="PUT", expected=400)
            request(f"/api/users/{admin['id']}", {"displayName": admin["displayName"], "role": "admin", "companyAccess": "Both", "isActive": False}, method="PUT", expected=400)
            assert row(admin["id"]) == admin_before
            request(f"/api/users/{admin['id']}/reset-password", {"password": replacement}, expected=204)
            request("/api/auth/me", expected=401)
            login("admin", replacement)
            second_admin = create("secondadmin", "admin")
            login("secondadmin")
            request(f"/api/users/{admin['id']}", {"displayName": admin["displayName"], "role": "shipping", "companyAccess": "Xingxin", "isActive": True, "pagePermissions": {"home": "view"}}, who="secondadmin", method="PUT")
            assert request("/api/auth/me")["role"] == "shipping"
            request("/api/users", expected=403)
            assert request("/api/auth/me", who="secondadmin")["role"] == "admin"
            checked.append("last-admin protection, admin self-reset/session invalidation and safe demotion with second admin")

            print("Permission boundary live HTTP/SQLite cases passed: " + str(len(checked)))
            for item in checked:
                print("PASS " + item)
        finally:
            stop()


if __name__ == "__main__":
    run()
