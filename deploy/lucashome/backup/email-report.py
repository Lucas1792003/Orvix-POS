#!/usr/bin/env python3
"""email-report.py - render the daily business report (stdlib only).

  email-report.py --report report.json --status status.json --out DIR [--health] [--now ISO]

Reads the JSON produced by email-report.sql for ONE organization and, with
--health, the backup status.json, and writes DIR/subject.txt, DIR/body.txt,
DIR/body.html. Totals and counts only; no personal data is in the input.
The backup-health block is platform information and is only rendered when
the report target asks for it (--health), i.e. for the operator's own org.
"""
import argparse
import datetime as dt
import html
import json
import os
import sys

# backup-status thresholds (seconds); keep in sync with backup-lib.sh / email-lib.sh defaults
THRESH = {"logical": 7200, "base": 93600, "restore-test": 691200, "email-archive": 691200}


def mmk(v):
    if v is None:
        v = 0
    try:
        return f"{int(v):,} MMK"
    except (TypeError, ValueError):
        return "-"


def parse_ts(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def age(now, s):
    t = parse_ts(s)
    if not t:
        return None
    return int((now - t).total_seconds())


def age_str(sec):
    if sec is None:
        return "never"
    if sec >= 86400:
        return f"{sec // 86400}d{(sec % 86400) // 3600:02d}h"
    if sec >= 3600:
        return f"{sec // 3600}h{(sec % 3600) // 60:02d}m"
    return f"{max(sec, 0) // 60}m"


def backup_health(status, now, archive_expected):
    """-> (ok: bool, lines: [str]) from status.json; missing/failed/stale jobs are problems."""
    jobs = (status or {}).get("jobs", {})
    lines, problems = [], []
    for job in ("logical", "base", "restore-test"):
        j = jobs.get(job, {})
        a = age(now, j.get("last_success"))
        res = j.get("last_result", "never")
        bad = res == "fail" or a is None or a > THRESH[job]
        if bad:
            problems.append(f"{job}: last result {res}, last success {age_str(a)} ago")
        lines.append(f"{job}: {res}, last success {age_str(a)} ago" + ("  <-- PROBLEM" if bad else ""))
    st = jobs.get("status", {})
    if st:
        n = len(st.get("problems") or [])
        bad = st.get("last_result") == "fail"
        lines.append(f"backup-status: {st.get('last_result', '?')} ({n} problem(s)), checked {age_str(age(now, st.get('last_run')))} ago"
                     + ("  <-- PROBLEM" if bad else ""))
        if bad:
            problems.append(f"backup-status reports {n} problem(s): " + "; ".join((st.get("problems") or [])[:3]))
    ea = jobs.get("email-archive", {})
    a = age(now, ea.get("last_success"))
    if ea:
        line = (f"weekly email archive: last sent {ea.get('last_archive_id', '?') if ea.get('last_result') == 'ok' else '-'}"
                f" ({ea.get('parts', '?')} part(s)) {age_str(a)} ago; last run {ea.get('last_result', '?')}")
    else:
        line = "weekly email archive: never run"
    bad = archive_expected and (ea.get("last_result") == "fail" or a is None or a > THRESH["email-archive"])
    if bad:
        problems.append("weekly email archive missing, failed or older than 8 days")
    lines.append(line + ("  <-- PROBLEM" if bad else ""))
    return (not problems), lines, problems


def render(rep, status, show_health, archive_expected, now):
    org = rep.get("org") or {}
    s, inv, pur, sh, rv, tr = (rep.get(k, {}) for k in ("sales", "inventory", "purchases", "shifts", "refund_void_requests", "transfers"))
    day = rep.get("day")
    title = f"Daily report {day} - {org.get('name', '?')}"
    health_ok, hlines, hproblems = (True, [], [])
    if show_health:
        health_ok, hlines, hproblems = backup_health(status, now, archive_expected)

    sections = []  # (heading, [lines])
    if show_health and not health_ok:
        sections.append(("ACTION NEEDED - backups", [f"- {p}" for p in hproblems]))
    sales_lines = [
        f"Sales completed: {s.get('completed_count', 0)}   refunded: {s.get('refunded_count', 0)}   voided: {s.get('void_count', 0)} ({mmk(s.get('void_total_mmk'))})",
        f"Revenue (excl. voids): {mmk(s.get('revenue_mmk'))}   discounts: {mmk(s.get('discount_mmk'))}   average ticket: {mmk(s.get('avg_ticket_mmk'))}",
        f"Units sold: {s.get('units_sold', 0)}   estimated cost of goods: {mmk(s.get('cogs_est_mmk'))}"
        f"   estimated gross margin: {mmk((s.get('revenue_mmk') or 0) - (s.get('cogs_est_mmk') or 0))}"
        + (f"   ({s.get('lines_without_cost')} line(s) without a cost)" if s.get("lines_without_cost") else ""),
    ]
    for p in s.get("by_payment") or []:
        sales_lines.append(f"  payment {p['method']}: {p['count']} sale(s), {mmk(p['total_mmk'])}")
    for p in s.get("by_shop") or []:
        sales_lines.append(f"  shop {p['code']} {p['name']}: {p['count']} sale(s), {mmk(p['total_mmk'])}")
    for p in s.get("top_products") or []:
        sales_lines.append(f"  top: {p['name']} x{p['qty']} = {mmk(p['revenue_mmk'])}")
    sections.append(("Sales", sales_lines))

    rl = [f"Requests created today: " + (", ".join(f"{x['type']} {x['status']} {x['count']}" for x in rv.get("created") or []) or "none"),
          f"Pending approval (all days): {rv.get('pending_total', 0)}"]
    sections.append(("Refunds and voids", rl))
    exp = rep.get("expenses") or {}
    sections.append(("Expenses", [exp.get("note", "-") if not exp.get("supported") else "-"]))

    il = [f"Tracked stock lines: {inv.get('tracked_items', 0)}   low stock: {inv.get('low_stock_count', 0)}   negative: {inv.get('negative_stock_count', 0)}",
          f"Stock value at cost: {mmk(inv.get('valuation_cost_mmk'))}   at retail: {mmk(inv.get('valuation_retail_mmk'))}"
          + (f"   ({inv.get('items_without_cost')} line(s) in stock without a cost)" if inv.get("items_without_cost") else "")]
    for x in inv.get("low_stock") or []:
        il.append(f"  low: [{x['shop']}] {x['name']}: {x['qty']} (threshold {x['threshold']})")
    if (inv.get("low_stock_count") or 0) > len(inv.get("low_stock") or []):
        il.append(f"  ... and {inv['low_stock_count'] - len(inv['low_stock'])} more")
    mv = inv.get("movements_today") or []
    if mv:
        il.append("Stock movements today: " + ", ".join(f"{m['type']} {m['count']}" for m in mv))
    sections.append(("Inventory", il))

    sections.append(("Purchases and suppliers", [
        f"Purchase orders created: {pur.get('created_count', 0)} ({mmk(pur.get('created_total_mmk'))})   received: {pur.get('received_count', 0)} ({mmk(pur.get('received_total_mmk'))})   open: {pur.get('open_orders', 0)}",
        f"Supplier debt (received, unpaid): {mmk(pur.get('supplier_debt_mmk'))} over {pur.get('unpaid_received_orders', 0)} order(s)",
        f"Supplier payments today: {pur.get('supplier_payments_count', 0)} ({mmk(pur.get('supplier_payments_mmk'))})",
    ]))
    shl = [f"Shifts opened: {sh.get('opened', 0)}   closed: {sh.get('closed', 0)}   still open now: {sh.get('open_now', 0)}   cash variance (closed today): {mmk(sh.get('variance_total_mmk'))}"]
    for x in sh.get("open_now_by_shop") or []:
        shl.append(f"  open: [{x['shop']}] {x['count']} shift(s), oldest started {x['oldest_start']}")
    for x in sh.get("closed_with_variance") or []:
        shl.append(f"  variance: [{x['shop']}] {mmk(x['variance_mmk'])}")
    sections.append(("Shifts", shl))
    sections.append(("Transfers and activity", [
        f"Stock transfers created: {tr.get('created', 0)}   received: {tr.get('received', 0)}   in transit: {tr.get('in_transit', 0)}",
        f"Audit events: {rep.get('audit_events', 0)}",
    ]))
    if show_health:
        sections.append(("Backup health", hlines))

    window = rep.get("window") or {}
    head = [title, f"Business day {day} ({rep.get('tz')}), {window.get('from')} to {window.get('to')}, {rep.get('shops', 0)} active shop(s).", ""]
    foot = ["", "Generated automatically from the POS database (read-only). Totals only; no customer data.",
            "Expenses are not tracked by the app. Cost-of-goods uses the cost captured at sale time where available."]
    text_lines = list(head)
    for h, ls in sections:
        text_lines += [h.upper(), *ls, ""]
    text_lines += foot
    text = "\n".join(text_lines) + "\n"

    esc = html.escape
    parts = [f"<div style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:680px\">",
             f"<h2 style=\"margin:0 0 4px\">{esc(title)}</h2><div style=\"color:#475569\">{esc(head[1])}</div>"]
    for h, ls in sections:
        warn = h.startswith("ACTION")
        style = "border:1px solid #fca5a5;background:#fef2f2;padding:8px 12px;border-radius:8px" if warn else ""
        parts.append(f"<div style=\"{style}\"><h3 style=\"margin:16px 0 6px;font-size:14px\">{esc(h)}</h3>"
                     + "".join(f"<div style=\"font-size:13px;white-space:pre-wrap\">{esc(x)}</div>" for x in ls) + "</div>")
    parts.append("<p style=\"font-size:12px;color:#64748b;margin-top:16px\">" + "<br>".join(esc(x) for x in foot if x) + "</p></div>")
    subject = ("[ACTION NEEDED] " if show_health and not health_ok else "") + \
        f"{title}: {s.get('completed_count', 0) + s.get('refunded_count', 0)} sale(s), {mmk(s.get('revenue_mmk'))}"
    return subject, text, "\n".join(parts) + "\n", health_ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--status")
    ap.add_argument("--out", required=True)
    ap.add_argument("--health", action="store_true")
    ap.add_argument("--archive-expected", action="store_true", help="treat a missing weekly email archive as a problem")
    ap.add_argument("--now")
    a = ap.parse_args()
    with open(a.report) as fh:
        rep = json.load(fh)
    status = {}
    if a.status and os.path.exists(a.status):
        try:
            with open(a.status) as fh:
                status = json.load(fh)
        except (OSError, ValueError):
            status = {"jobs": {"status": {"last_result": "fail", "problems": ["status.json unreadable"]}}}
    now = parse_ts(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
    subject, text, body_html, ok = render(rep, status, a.health, a.archive_expected, now)
    os.makedirs(a.out, exist_ok=True)
    for name, content in (("subject.txt", subject + "\n"), ("body.txt", text), ("body.html", body_html)):
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as fh:
            fh.write(content)
    print("health=" + ("ok" if ok else "problem"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
