#!/usr/bin/env python3
"""发票号自动录入系统 Web 版（局域网/服务器部署）
用法: python3 app.py [--host 0.0.0.0] [--port 5010]
环境变量: PORT 端口(默认5010)  APP_TOKEN 访问口令(设置后需登录)
"""
import os, sys, json, uuid, threading, argparse, datetime
from flask import Flask, request, jsonify, send_file, render_template, session, redirect

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
UPLOADS = os.path.join(BASE, "uploads")
OUTPUT = os.path.join(BASE, "output")
for d in (DATA, UPLOADS, OUTPUT): os.makedirs(d, exist_ok=True)

sys.path.insert(0, BASE)
from matcher_unified import UnifiedMatcher
import build_db, process_schedule

app = Flask(__name__)
app.secret_key = os.urandom(24)
app.config["MAX_CONTENT_LENGTH"] = 600 * 1024 * 1024  # 600MB

TOKEN = os.environ.get("APP_TOKEN", "").strip()

state = {"building": False, "build_log": [], "jobs": {}}
lock = threading.Lock()
_matcher = None

def get_matcher():
    global _matcher
    if _matcher is None:
        _matcher = UnifiedMatcher(DATA)
    return _matcher

def reload_matcher():
    global _matcher
    _matcher = UnifiedMatcher(DATA)
    return _matcher

@app.before_request
def gate():
    if not TOKEN: return None
    if request.endpoint in ("login", "static"): return None
    if session.get("ok"): return None
    return redirect("/login")

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        if request.form.get("token", "").strip() == TOKEN:
            session["ok"] = True
            return redirect("/")
        return render_template("login.html", error="口令错误"), 403
    return render_template("login.html", error=None)

@app.route("/")
def index():
    m = get_matcher()
    meta = {}
    mp = os.path.join(DATA, "meta.json")
    if os.path.exists(mp): meta = json.load(open(mp))
    return render_template("index.html", status=m.status(), meta=meta,
                           building=state["building"], token=bool(TOKEN))

def _save_files(files, sub):
    paths = []
    for f in files:
        if not f or not f.filename: continue
        fn = os.path.basename(f.filename)
        p = os.path.join(UPLOADS, sub, f"{datetime.datetime.now():%Y%m%d%H%M%S}_{fn}")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        f.save(p); paths.append(p)
    return paths

@app.route("/admin/rebuild", methods=["POST"])
def rebuild():
    if state["building"]:
        return jsonify({"ok": False, "msg": "正在建库中，请稍候"}), 409
    paths = _save_files(request.files.getlist("files") or request.files.getlist("files_2025") or request.files.getlist("files_zb"), "db")
    if not paths:
        return jsonify({"ok": False, "msg": "未收到发票文件"}), 400

    def work():
        state["building"] = True
        state["build_log"] = []
        log = lambda s: (state["build_log"].append(str(s)), None)[0]
        try:
            log(f"收到 {len(paths)} 个文件，自动识别类型...")
            p2025, pzb = [], []
            for p in paths:
                try:
                    t = build_db.detect_file_type(p)
                except Exception as e:
                    log(f"  ⚠ {os.path.basename(p)}: {e}")
                    continue
                (pzb if t == "zb" else p2025).append(p)
                log(f"  {os.path.basename(p)} -> {'ZB减价发票(含汇总表)' if t=='zb' else '发票原件(sheet逐张)'}")
            # 全量重建：保留已有库对应类型的文件也要一起传；这里直接用本次文件重建对应类型
            if p2025: build_db.build_2025(p2025, DATA, log)
            if pzb: build_db.build_zb(pzb, DATA, log)
            meta = {"built_at": datetime.datetime.now().isoformat(timespec="seconds"),
                    "files_2025": [os.path.basename(p) for p in p2025],
                    "files_zb": [os.path.basename(p) for p in pzb]}
            json.dump(meta, open(os.path.join(DATA, "meta.json"), "w"), ensure_ascii=False)
            m = reload_matcher()
            log(f"完成: {m.status()}")
        except Exception as e:
            log(f"建库失败: {e!r}")
        finally:
            state["building"] = False
    threading.Thread(target=work, daemon=True).start()
    return jsonify({"ok": True})

@app.route("/admin/db_status")
def db_status():
    return jsonify({"building": state["building"], "log": state["build_log"][-50:],
                    "status": get_matcher().status()})

@app.route("/process", methods=["POST"])
def process():
    m = get_matcher()
    if not m.status()["ready"]:
        return jsonify({"ok": False, "msg": "发票库为空，请先在页面上方上传发票原件建库"}), 400
    paths = _save_files(request.files.getlist("files"), "schedule")
    if not paths:
        return jsonify({"ok": False, "msg": "未收到排期文件"}), 400
    jid = uuid.uuid4().hex[:12]
    state["jobs"][jid] = {"status": "running", "log": [], "items": []}

    def work():
        job = state["jobs"][jid]
        log = lambda s: job["log"].append(str(s))
        try:
            for p in paths:
                log(f"处理 {os.path.basename(p)} ...")
                out, cls, stats = process_schedule.process(p, OUTPUT, m, log)
                job["items"].append({"input": os.path.basename(p), "result": out, "report": cls, "stats": stats})
                log(f"完成: {stats}")
            job["status"] = "done"
        except Exception as e:
            job["status"] = "error"; log(f"处理失败: {e!r}")
    threading.Thread(target=work, daemon=True).start()
    return jsonify({"ok": True, "job": jid})

@app.route("/job/<jid>")
def job(jid):
    j = state["jobs"].get(jid)
    if not j: return jsonify({"ok": False}), 404
    return jsonify({"ok": True, "status": j["status"], "log": j["log"][-60:],
                    "items": [{"input": it["input"], "stats": it["stats"],
                               "result": f"/download/{jid}/{i}/result", "report": f"/download/{jid}/{i}/report"}
                              for i, it in enumerate(j["items"])]})

@app.route("/download/<jid>/<int:idx>/<kind>")
def download(jid, idx, kind):
    j = state["jobs"].get(jid)
    if not j or idx >= len(j["items"]): return "not found", 404
    p = j["items"][idx]["result" if kind == "result" else "report"]
    return send_file(p, as_attachment=True, download_name=os.path.basename(p))

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5010")))
    args = ap.parse_args()
    from waitress import serve
    print(f"发票号自动录入系统 Web版  http://{args.host}:{args.port}")
    serve(app, host=args.host, port=args.port, threads=8)
