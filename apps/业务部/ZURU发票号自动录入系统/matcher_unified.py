#!/usr/bin/env python3
"""统一发票号匹配模块（精确度优先）
- 2025 系列发票原件：sheet-per-invoice，PO精确 + 货号候选 + 数量/日期消歧，禁PO级回退，日期跨度护栏
- 2026 ZB 系列：行号级映射（实体sheet优先，累计汇总表兜底），PO行号后缀÷10 对齐
"""
import json, re, datetime
from collections import defaultdict

PINK = "FFB6C1"

def code_candidates(s):
    """从货号各段提取候选：4-6位数字段（>6位去前导零）+ 含字母的完整段（如 MEC251/MUQ55/9279SQ1，≥5位）"""
    cands = set()
    for seg in re.split(r'[^A-Za-z0-9]+', str(s)):
        for run in re.findall(r'\d+', seg):
            r = run.lstrip('0') or '0'
            if 4 <= len(r) <= 6:
                cands.add(r)
        # 混装/套装代码：含字母且整体≥5位，整段精确匹配（数字不足4位也能对上，如 MEC251）
        if len(seg) >= 5 and re.search(r'[A-Za-z]', seg) and re.search(r'\d', seg):
            cands.add(seg.upper())
    return cands

def line_qtys_for(items, cs):
    """取候选货号对应明细行的数量：同一候选若被多个货号命中（如套装行 92129SLB 与部件行 92129），
    只取货号最短的（最贴近部件），避免套装行与部件行重复计数；同货号多行照常合计"""
    matched = {}
    for it in items:
        for c in code_candidates(it.get("code", "")):
            if c in cs:
                matched.setdefault(c, []).append((len(str(it["code"])), it["qty"]))
    qtys = []
    for c, lst in matched.items():
        m = min(l for l, _ in lst)
        qtys.extend(q for l, q in lst if l == m)
    return qtys

def norm_code(v):
    if v is None: return None
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    if isinstance(v, int): return str(v)
    s = str(v).strip()
    return s[:-2] if re.fullmatch(r'\d+\.0', s) else (s or None)

def parse_date(v):
    if isinstance(v, datetime.datetime): return v.date()
    if isinstance(v, datetime.date): return v
    if isinstance(v, str):
        m = re.match(r'(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})', v.strip())
        if m:
            try: return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError: return None
    return None

class UnifiedMatcher:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.db, self.po2inv, self.inv_items = {}, {}, {}
        self.zb_summary, self.zb_phys = {}, {}
        self.load()

    def load(self):
        import os
        d = self.data_dir
        p_db = os.path.join(d, "发票DB_2025全年.json")
        p_po = os.path.join(d, "PO到发票_2025全年.json")
        if os.path.exists(p_db) and os.path.exists(p_po):
            self.db = json.load(open(p_db))
            self.po2inv = json.load(open(p_po))
            self.inv_items = {}
            for inv, dd in self.db.items():
                m = defaultdict(list)
                for it in dd["items"]:
                    for c in code_candidates(it["code"]):
                        m[c].append(it["qty"])
                self.inv_items[inv] = dict(m)
        p_zs = os.path.join(d, "ZB映射_PO行号到发票.json")
        p_zp = os.path.join(d, "ZB实体sheet_PO映射.json")
        if os.path.exists(p_zs):
            self.zb_summary = json.load(open(p_zs))
        if os.path.exists(p_zp):
            raw = json.load(open(p_zp))
            self.zb_phys = {}
            for poline, names in raw.items():
                invs = set()
                for n in names:
                    m = re.match(r'^(ZB\d+)(?:\(REV\d+[）)])?折?', n)
                    if m: invs.add(m.group(1))
                if invs: self.zb_phys[poline] = sorted(invs)
        # ZB 实体sheet明细：按客PO索引（仅保留能定发票号的记录）；另建 发票号→明细 索引
        self.zb_by_cust = {}
        self.zb_inv_items = {}
        p_zd = os.path.join(d, "ZB实体sheet_明细.json")
        if os.path.exists(p_zd):
            for rec in json.load(open(p_zd)):
                invs = []
                m = re.match(r'^(ZB\d+)(?:\(REV\d+[）)])?折?', rec.get("sheet", ""))
                if m: invs = [m.group(1)]
                if not invs: continue
                self.zb_inv_items.setdefault(invs[0], []).extend(rec.get("items", []))
                for cp in rec.get("cust", []):
                    self.zb_by_cust.setdefault(cp, []).append({"invs": invs, "items": rec.get("items", [])})
        # ZB PO→发票 索引（汇总表key前缀 + 实体sheet J8前缀）
        self.zb_po2inv = {}
        for k, v in self.zb_summary.items():
            self.zb_po2inv.setdefault(k.split("-")[0], [])
            if v["inv"] not in self.zb_po2inv[k.split("-")[0]]:
                self.zb_po2inv[k.split("-")[0]].append(v["inv"])
        for k, v in self.zb_phys.items():
            po = k.split("-")[0]
            self.zb_po2inv.setdefault(po, [])
            for i in v:
                if i not in self.zb_po2inv[po]:
                    self.zb_po2inv[po].append(i)

    def status(self):
        return {
            "2025发票": len(self.db), "2025PO": len(self.po2inv),
            "ZB汇总表": len(self.zb_summary), "ZB实体sheet": len(self.zb_phys),
            "ready": bool(self.db or self.zb_summary or self.zb_phys),
        }

    # ---------- 2025 系列 ----------
    def _date_gap(self, inv, row_date):
        d0 = self.db[inv]["date"]
        if not d0 or not row_date: return None
        return (datetime.date.fromisoformat(d0) - row_date).days

    def _date_ok(self, inv, row_date):
        g = self._date_gap(inv, row_date)
        return True if g is None else -14 <= g <= 75

    def match_2025(self, po, hh_str, qty, row_date, sibling_qty=None):
        """-> (status, pred, reason)  status: fill/review/no_invoice"""
        invs = self.po2inv.get(po, [])
        if not invs: return ("no_invoice", None, "PO在2025发票库中无记录")
        cs = code_candidates(hh_str)
        hit_c = lambda i: bool(cs) and bool(cs & set(self.inv_items.get(i, {})))
        if len(invs) == 1:
            inv = invs[0]
            if not self.inv_items.get(inv):
                return ("review", None, f"唯一发票{inv}无货号明细，无法校验")
            if not cs:
                return ("review", None, f"货号[{hh_str}]无法提取数字候选，转人工(禁PO级回退)")
            if not hit_c(inv):
                return ("review", None, f"货号不在唯一发票{inv}明细中")
            if not self._date_ok(inv, row_date):
                return ("review", inv, f"唯一发票{inv}货号命中但日期跨度{self._date_gap(inv,row_date)}天")
            # 入多护栏：1:1数量口径下，唯一发票的数量不够排期待填行分 → 转复核
            if qty is not None and sibling_qty is not None:
                line_qtys = line_qtys_for(self.db[inv]["items"], cs)
                inv_q = sum(line_qtys)
                one2one = any(abs(q - qty) < 1e-6 for q in line_qtys)
                if one2one and sibling_qty > inv_q + 1e-6:
                    return ("review", inv, f"唯一发票{inv}该货号仅{inv_q:.0f}，排期待填共{sibling_qty:.0f}，数量不够分")
            return ("fill", inv, "唯一发票+货号命中")
        if not cs:
            return ("review", None, f"{len(invs)}张候选发票且货号[{hh_str}]无法提取，转人工")
        hit = [i for i in invs if hit_c(i)]
        if not hit: return ("review", None, f"{len(invs)}张发票均无此货号(应不填)")

        def hit_qty(inv):
            """该发票中命中货号的数量合计（剔除套装/部件重复计数）"""
            return sum(line_qtys_for(self.db[inv]["items"], cs))

        if len(hit) > 1 and qty is not None:
            # 分批出货规则：多张发票命中货号的数量合计 = 该PO该货号在排期中的总行数量 -> 合并填入
            # sibling_qty 由调用方按 (PO,货号候选) 分组汇总，防止多个相同行各自重复合并同一组发票
            target = sibling_qty if sibling_qty is not None else qty
            total = sum(hit_qty(i) for i in hit)
            if abs(total - target) < 1e-6:
                return ("fill", "/".join(sorted(hit)), f"同货号分{len(hit)}批出货，数量合计与排期总量吻合，合并填入")
            qh = [i for i in hit if any(abs(q - qty) < 1e-6 for q in line_qtys_for(self.db[i]["items"], cs))]
            if len(qh) == 1: hit = qh
            elif qh: hit = qh
        if len(hit) > 1 and row_date:
            dh = [i for i in hit if self._date_ok(i, row_date)]
            if len(dh) == 1: hit = dh
        if len(hit) == 1:
            if not self._date_ok(hit[0], row_date):
                return ("review", hit[0], f"消歧后唯一{hit[0]}但日期跨度{self._date_gap(hit[0],row_date)}天")
            if qty is not None and sibling_qty is not None:
                line_qtys = line_qtys_for(self.db[hit[0]]["items"], cs)
                inv_q = sum(line_qtys)
                one2one = any(abs(q - qty) < 1e-6 for q in line_qtys)
                if one2one and sibling_qty > inv_q + 1e-6:
                    return ("review", hit[0], f"消歧后唯一{hit[0]}但该货号仅{inv_q:.0f}，排期待填共{sibling_qty:.0f}，数量不够分")
            return ("fill", hit[0], f"{len(invs)}张候选消歧后唯一")
        return ("review", "/".join(sorted(hit)), f"歧义:剩{len(hit)}张候选")

    # ---------- 2026 ZB 系列 ----------
    def _zb_keys(self, po, poline):
        ks = []
        if poline:
            ks.append(poline)
            m = re.match(r'^(\d+)-(\d+)$', poline)
            if m and int(m.group(2)) % 10 == 0:
                ks.append(f"{m.group(1)}-{int(m.group(2))//10}")
        if po: ks.append(po)
        return ks

    def _zb_verify(self, inv, hh_str):
        """用ZB发票明细校验货号：有明细且货号可提取时必须命中。返回 True/False/None(无法校验)"""
        items = self.zb_inv_items.get(inv)
        if not items: return None
        cs = code_candidates(hh_str)
        if not cs: return None
        ic = set()
        for it in items: ic |= code_candidates(it["code"])
        return bool(cs & ic)

    def match_zb(self, po, poline, hh_str, qty=None, sibling_qty=None):
        """-> (inv, source) / ("", review_note) / (None, '')
        货号+数量账优先（发票J8行号实为出货批次号，不可靠）；行号映射仅作无明细时的兜底"""
        invs = self.zb_po2inv.get(po, [])
        if not invs: return None, ""
        cs = code_candidates(hh_str)

        def code_set(inv):
            s = set()
            for it in self.zb_inv_items.get(inv, []): s |= code_candidates(it["code"])
            return s

        def line_qtys(inv):
            return line_qtys_for(self.zb_inv_items.get(inv, []), cs)

        hits = [i for i in invs if cs and (cs & code_set(i))]
        if hits:
            if len(hits) == 1:
                if qty is not None and sibling_qty is not None:
                    lq = line_qtys(hits[0])
                    inv_q = sum(lq)
                    if any(abs(q - qty) < 1e-6 for q in lq) and sibling_qty > inv_q + 1e-6:
                        return "", f"唯一ZB发票{hits[0]}该货号仅{inv_q:.0f}，排期待填共{sibling_qty:.0f}，数量不够分"
                return hits[0], "ZB货号匹配"
            if qty is not None:
                # 同货号分批合并：多张发票该货号数量合计=排期组总量
                target = sibling_qty if sibling_qty is not None else qty
                total = sum(sum(line_qtys(i)) for i in hits)
                if abs(total - target) < 1e-6:
                    return "/".join(sorted(hits)), f"ZB同货号分{len(hits)}批出货，数量合计吻合，合并填入"
                qh = [i for i in hits if any(abs(q - qty) < 1e-6 for q in line_qtys(i))]
                if len(qh) == 1:
                    lq = line_qtys(qh[0])
                    if sibling_qty is not None and sibling_qty > sum(lq) + 1e-6:
                        return "", f"ZB发票{qh[0]}数量匹配但同组还有其他行，{sum(lq):.0f}不够分，转人工"
                    return qh[0], "ZB货号+数量命中"
            return "", f"歧义:剩{len(hits)}张候选|" + "/".join(sorted(hits))
        # 货号无命中：行号映射兜底（仅限该发票无明细、无法反证的情形）
        for k in self._zb_keys(po, poline):
            if k in self.zb_phys:
                v = self.zb_phys[k]
                inv = v[0] if len(v) == 1 else "/".join(v)
                if inv not in self.zb_inv_items:
                    return inv, "ZB实体sheet行号级(无明细可校验)"
                return "", f"候选{inv}：实体sheet行号对得上但货号不符，转人工"
        for k in self._zb_keys(po, poline):
            if k in self.zb_summary:
                inv = self.zb_summary[k]["inv"]
                if inv not in self.zb_inv_items:
                    return inv, "ZB汇总表行号级(无明细可校验)"
                return "", f"候选{inv}：汇总表行号对得上但货号不符，转人工"
        if cs:
            return "", f"{len(invs)}张ZB发票均无此货号(应不填)"
        return "", f"货号[{hh_str}]无法提取且行号不对应，转人工"

    def zb_candidates(self, po):
        """行号对不上时，列出该PO在ZB库中的全部候选发票（去重、按号排序）"""
        invs = set()
        for k, v in self.zb_summary.items():
            if k.split("-")[0] == po:
                invs.add(v["inv"].split("(")[0])
        for k, v in self.zb_phys.items():
            if k.split("-")[0] == po:
                invs.update(v)
        return sorted(invs)

    def match_zb_cust(self, cust_po, hh_str, qty, sibling_qty=None):
        """按客PO匹配ZB实体发票：-> (status, inv或candidates, source)
        status: fill / review / none"""
        recs = self.zb_by_cust.get((cust_po or "").strip(), [])
        if not recs: return ("none", None, "")
        cands = {}
        for r in recs:
            for inv in r["invs"]:
                cands.setdefault(inv, []).extend(r["items"])
        if not cands: return ("none", None, "")
        cs = code_candidates(hh_str)
        def inv_hit(items):
            ic = set()
            for it in items: ic |= code_candidates(it["code"])
            return bool(cs and cs & ic)
        if len(cands) == 1:
            inv, items = next(iter(cands.items()))
            # 与2025分支同一纪律：发票有明细且货号可提取时必须命中（一个客PO可能对应多个货号）
            if items and cs and not inv_hit(items):
                return ("review", inv, f"客PO唯一发票{inv}但货号不在其明细中")
            # 入多护栏
            if qty is not None and sibling_qty is not None and items and cs:
                line_qtys = line_qtys_for(items, cs)
                inv_q = sum(line_qtys)
                one2one = any(abs(q - qty) < 1e-6 for q in line_qtys)
                if one2one and sibling_qty > inv_q + 1e-6:
                    return ("review", inv, f"客PO唯一发票{inv}该货号仅{inv_q:.0f}，排期待填共{sibling_qty:.0f}，数量不够分")
            return ("fill", inv, "ZB客PO唯一命中")
        hit = [inv for inv, items in cands.items() if inv_hit(items)]
        if len(hit) == 1:
            return ("fill", hit[0], "ZB客PO+货号命中")
        if len(hit) > 1 and qty is not None:
            qh = [inv for inv in hit if any(abs(q - qty) < 1e-6 for q in line_qtys_for(cands[inv], cs))]
            if len(qh) == 1:
                return ("fill", qh[0], "ZB客PO+货号+数量命中")
        pool = hit or sorted(cands)
        return ("review", "/".join(sorted(pool)), f"客PO对应{len(cands)}张ZB发票,未能唯一确定")

    # ---------- 统一分类 ----------
    def classify(self, po, poline, hh_str, qty, row_date, country="", sibling_qty=None, cust_po=""):
        """返回 dict: class/fill(发票号或None)/source/note
        class: fill / review / none
        """
        year = row_date.year if row_date else None
        if year and year <= 2025:
            status, pred, reason = self.match_2025(po, hh_str, qty, row_date, sibling_qty)
            if status == "no_invoice" and cust_po:
                # 部分发票(如Rascals/Millie Moon)的PO栏记的是客PO
                status2, pred2, reason2 = self.match_2025(cust_po, hh_str, qty, row_date, sibling_qty)
                if status2 != "no_invoice":
                    status, pred, reason = status2, pred2, reason2 + "(按客PO匹配)"
            if status == "fill":
                return {"class": "fill", "inv": pred, "source": "2025发票原件", "note": reason}
            if status == "review":
                cands = pred or ""
                if not cands and "无法提取" in reason:
                    cands = "/".join(sorted(self.po2inv.get(po, [])))
                    reason += "；已附该PO全部发票候选"
                return {"class": "review", "inv": None, "candidates": cands, "source": "2025发票原件", "note": reason}
            z, how = self.match_zb(po, poline, hh_str, qty, sibling_qty)
            if z:
                return {"class": "fill", "inv": z, "source": how, "note": "2025发票库无记录，ZB系列命中"}
            if z == "":
                return {"class": "review", "inv": None, "candidates": how.split("：")[0].replace("候选",""),
                        "source": "ZB", "note": "2025无记录；" + how}
            zs, zp, zhow = self.match_zb_cust(cust_po, hh_str, qty, sibling_qty)
            if zs == "fill":
                return {"class": "fill", "inv": zp, "source": zhow, "note": "2025发票库无记录，按客PO命中ZB实体发票"}
            cands = self.zb_candidates(po)
            if zs == "review" and zp:
                cands = sorted(set(cands) | set(str(zp).split("/")))
            if cands:
                return {"class": "review", "inv": None, "candidates": "/".join(cands),
                        "source": "ZB", "note": f"2025无记录；PO行号与ZB汇总表不对应，附{len(cands)}张ZB候选(可能同货号分批出货，需人工按数量确认)"}
            return {"class": "none", "inv": None, "source": "", "note": "2025及ZB发票源均无此PO"}
        # 2026 及以后 / 无年份 → ZB（先客PO精确匹配，再PO级货号匹配）
        zs, zp, zhow = self.match_zb_cust(cust_po, hh_str, qty, sibling_qty)
        if zs == "fill":
            return {"class": "fill", "inv": zp, "source": zhow, "note": "按客PO命中"}
        z, how = self.match_zb(po, poline, hh_str, qty, sibling_qty)
        if z:
            note = "" if country in ("", "美国") else "注意:非美国订单却命中美国ZB汇总表"
            return {"class": "fill", "inv": z, "source": how, "note": note or "ZB命中"}
        if z == "":
            cands2 = how.split("|")[-1] if "|" in how else how.split("：")[0].replace("候选","")
            if "无法提取" in how:
                cands2 = "/".join(sorted(self.zb_po2inv.get(po, [])))
                how += "；已附该PO全部ZB发票候选"
            return {"class": "review", "inv": None, "candidates": cands2, "source": "ZB", "note": how}
        cands = self.zb_candidates(po)
        if zs == "review" and zp:
            cands = sorted(set(cands) | set(str(zp).split("/")))
        if cands:
            return {"class": "review", "inv": None, "candidates": "/".join(cands),
                    "source": "ZB", "note": f"PO行号与ZB汇总表不对应，附{len(cands)}张ZB候选(可能同货号分批出货，需人工按数量确认)"}
        # ZB 无结果：回退2025发票库（年底开票滞后，走货2026年初的票可能开在2025库）
        status, pred, reason = self.match_2025(po, hh_str, qty, row_date, sibling_qty)
        if status == "fill":
            return {"class": "fill", "inv": pred, "source": "2025发票原件", "note": "ZB无记录，2025库命中(跨年)" + reason}
        if status == "review":
            return {"class": "review", "inv": None, "candidates": pred or "", "source": "2025发票原件", "note": "跨年候选:" + reason}
        if country == "美国":
            return {"class": "none", "inv": None, "source": "", "note": "美国行未命中ZB汇总表/实体sheet/客PO"}
        return {"class": "none", "inv": None, "source": "", "note": "非美国订单，ZB仅覆盖美国；需旧系列发票或接单表"}
