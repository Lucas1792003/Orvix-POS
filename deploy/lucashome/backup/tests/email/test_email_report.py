#!/usr/bin/env python3
"""Unit tests for email-report.py rendering (fixtures only, stdlib unittest).

  python3 -I test_email_report.py [path/to/email-report.py]
"""
import datetime as dt
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith(".py") else os.path.join(HERE, "..", "..", "email-report.py")
spec = importlib.util.spec_from_file_location("email_report", SRC)
er = importlib.util.module_from_spec(spec)
spec.loader.exec_module(er)
NOW = dt.datetime(2026, 10, 13, 1, 0, tzinfo=dt.timezone.utc)

REPORT = {
    "schema": 1, "org": {"id": "org-a", "name": "Org <A> & Co"}, "day": "2026-10-12", "tz": "Asia/Yangon",
    "window": {"from": "2026-10-11T17:30:00+00:00", "to": "2026-10-12T17:30:00+00:00"}, "shops": 1,
    "sales": {"completed_count": 2, "refunded_count": 1, "void_count": 1, "void_total_mmk": 700, "revenue_mmk": 7500,
              "discount_mmk": 100, "avg_ticket_mmk": 2500, "units_sold": 6, "cogs_est_mmk": 4500, "lines_without_cost": 0,
              "by_payment": [{"method": "CASH", "count": 2, "total_mmk": 5000}], "by_shop": [{"code": "SA", "name": "Shop A", "count": 3, "total_mmk": 7500}],
              "top_products": [{"name": "Rice", "qty": 5, "revenue_mmk": 5000}]},
    "refund_void_requests": {"created": [{"type": "VOID", "status": "APPROVED", "count": 1}], "pending_total": 1},
    "expenses": {"supported": False, "note": "the app has no expenses table"},
    "inventory": {"tracked_items": 3, "low_stock_count": 17, "low_stock": [{"shop": "SA", "name": "Salt", "qty": 0, "threshold": 5}] * 15,
                  "negative_stock_count": 0, "valuation_cost_mmk": 76800, "valuation_retail_mmk": 128000, "items_without_cost": 0, "movements_today": []},
    "purchases": {"created_count": 1, "created_total_mmk": 8000, "received_count": 1, "received_total_mmk": 50000, "open_orders": 1,
                  "supplier_debt_mmk": 30000, "unpaid_received_orders": 1, "supplier_payments_count": 1, "supplier_payments_mmk": 20000},
    "shifts": {"opened": 2, "closed": 1, "open_now": 1, "open_now_by_shop": [], "variance_total_mmk": -500, "closed_with_variance": [{"shop": "SA", "variance_mmk": -500}]},
    "transfers": {"created": 0, "received": 0, "in_transit": 0}, "audit_events": 3,
}


def ok_status(archive_age_h=30):
    t = lambda h: (NOW - dt.timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"jobs": {
        "logical": {"last_result": "ok", "last_success": t(0.5)},
        "base": {"last_result": "ok", "last_success": t(20)},
        "restore-test": {"last_result": "ok", "last_success": t(48)},
        "status": {"last_result": "ok", "last_run": t(0.2), "problems": []},
        "email-archive": {"last_result": "ok", "last_success": t(archive_age_h), "last_archive_id": "pos-2026-W41", "parts": 1},
    }}


class RenderTests(unittest.TestCase):
    def test_totals_and_escaping(self):
        subj, text, html, ok = er.render(REPORT, ok_status(), True, True, NOW)
        self.assertTrue(ok)
        self.assertNotIn("ACTION NEEDED", subj)
        self.assertIn("3 sale(s), 7,500 MMK", subj)
        self.assertIn("Revenue (excl. voids): 7,500 MMK", text)
        self.assertIn("estimated gross margin: 3,000 MMK", text)
        self.assertIn("Supplier debt (received, unpaid): 30,000 MMK", text)
        self.assertIn("... and 2 more", text)                       # 17 low-stock, 15 listed
        self.assertIn("Org &lt;A&gt; &amp; Co", html)              # HTML-escaped
        self.assertNotIn("<A>", html)
        self.assertIn("weekly email archive: last sent pos-2026-W41", text)

    def test_backup_problems_raise_subject_flag(self):
        st = ok_status()
        st["jobs"]["logical"]["last_result"] = "fail"
        st["jobs"]["status"] = {"last_result": "fail", "last_run": "2026-10-13T00:50:00Z", "problems": ["WAL archiving failing"]}
        subj, text, html, ok = er.render(REPORT, st, True, True, NOW)
        self.assertFalse(ok)
        self.assertTrue(subj.startswith("[ACTION NEEDED]"))
        self.assertIn("ACTION NEEDED - BACKUPS", text)
        self.assertIn("WAL archiving failing", text)

    def test_stale_or_missing_weekly_archive_is_a_problem(self):
        _, text, _, ok = er.render(REPORT, ok_status(archive_age_h=24 * 9), True, True, NOW)
        self.assertFalse(ok)
        st = ok_status(); del st["jobs"]["email-archive"]
        _, text2, _, ok2 = er.render(REPORT, st, True, True, NOW)
        self.assertFalse(ok2)
        self.assertIn("weekly email archive: never run", text2)
        _, _, _, ok3 = er.render(REPORT, st, True, False, NOW)     # archive not expected yet (tier disabled)
        self.assertTrue(ok3)

    def test_no_health_block_without_option(self):
        subj, text, html, ok = er.render(REPORT, {"jobs": {}}, False, False, NOW)
        self.assertTrue(ok)
        self.assertNotIn("BACKUP HEALTH", text)
        self.assertNotIn("weekly email archive", text)

    def test_empty_day(self):
        empty = {"org": {"id": "o", "name": "O"}, "day": "2026-10-12", "tz": "Asia/Yangon", "sales": {}, "inventory": {}}
        subj, text, html, ok = er.render(empty, {}, False, False, NOW)
        self.assertIn("0 sale(s), 0 MMK", subj)
        self.assertIn("Sales completed: 0", text)
        self.assertIn("EXPENSES", text)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=2)
