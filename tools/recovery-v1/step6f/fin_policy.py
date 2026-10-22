"""Step 6 finalization -- owner-approved FINANCIAL POLICY tests at the database level (PFIN-F split refunds, alternative
payouts, refund price adjustment, non-cash payout confirmation, f10 / f125; PDISC-A discount authorization).

Run (private disposable cluster only; synthetic data only):
  python3 -I tools/recovery-v1/db/db-smoke.py --stage 86 --financial --script2-pre tools/recovery-v1/step6f/fin_policy.py
  (also with --with-087)

Isolation: everything runs in `fin_p6`, a CREATE DATABASE ... TEMPLATE copy of the harness database at the pre-hook point
(after the financial migrations, before Recovery V1). Every refusal is checked to leave every financial table unchanged.
Evidence: <run>/p6-trace.log, <run>/p6-results.json.
"""
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'script2'))
import fin_integrity as fi  # noqa: E402

DB = 'fin_p6'
L, J, item = fi.L, fi.J, fi.item


class P(fi.F):
    STATE = ("SELECT json_build_object('sales',(SELECT count(*) FROM sales),'pay',(SELECT count(*) FROM sale_payments),"
             "'cm',(SELECT count(*) FROM cash_movements),'req',(SELECT count(*) FROM refund_void_requests),"
             "'appr',(SELECT count(*) FROM refund_void_requests WHERE status='APPROVED'),'rl',(SELECT count(*) FROM refund_lines),"
             "'rp',(SELECT count(*) FROM refund_payouts),'mv',(SELECT count(*) FROM inventory_movements),"
             "'inv',(SELECT sum(qty_base_units) FROM inventory),'idem',(SELECT count(*) FROM idempotency_keys),"
             "'fa',(SELECT count(*) FROM fin_approvals),'fad',(SELECT count(*) FROM fin_approvals WHERE status<>'REQUESTED'),"
             "'fac',(SELECT count(*) FROM fin_approvals WHERE consumed_sale_id IS NOT NULL),"
             "'rpc',(SELECT count(*) FROM refund_payout_confirmations),'audit',(SELECT count(*) FROM audit_logs))::text;")

    def __init__(self, ctx):  # noqa: D401 -- same plumbing as fin_integrity.F, own database and evidence files
        self.ctx = ctx
        self.run = ctx['run']
        self.env = dict(ctx['env'])
        a = list(ctx['dbargs'])
        a[a.index('-d') + 1] = DB
        self.args = a
        self.trace = open(self.run / 'p6-trace.log', 'w')
        (self.run / 'fin-sessions').mkdir(exist_ok=True)
        self.results = []
        self.k = 0
        self.headers = None

    def key(self):
        self.k += 1
        return 'f6000000-0000-4000-8000-%012d' % self.k

    def key7(self):
        # a real UUIDv7 (current Unix ms): 086 accepts executor keys only inside its time window
        self.k += 1
        h = '%012x' % int(time.time() * 1000)
        return '%s-%s-7%03x-8000-%012d' % (h[:8], h[8:], self.k % 4096, self.k)

    def prefix(self, who):
        h = '' if self.headers is None else "SELECT set_config('request.headers', %s, false) AS zh \\gset\n" % L(json.dumps(self.headers))
        return h + ('' if who is None else "SELECT test.login('%s') AS zz \\gset\nSET ROLE authenticated;\n" % fi.U[who])

    def with_headers(self, h, fn):
        self.headers = h
        try:
            return fn()
        finally:
            self.headers = None

    # ---- helpers
    def sale_items(self, n, pid='prod-1', disc=None):
        it = {'product_id': pid, 'qty': n}
        if disc is not None:
            it['item_discount_pct'] = disc
        return [it]

    def approval(self, rid, kind):
        return self.j("SELECT coalesce((SELECT row_to_json(f)::text FROM fin_approvals f WHERE subject_id=%s AND kind=%s), 'null');" % (L(rid), L(kind)))

    def decide_sql(self, aid, decision, reason='policy test decision', key=None):
        return "SELECT public.fin_decide_approval(%s, %s, %s, %s)::text;" % (L(aid), L(decision), L(reason), L(key or self.key()))

    def decide(self, who, aid, decision='APPROVE', reason='policy test decision'):
        return self.j(self.decide_sql(aid, decision, reason), who)

    def payouts(self, rid):
        return self.j("SELECT coalesce(json_agg(json_build_object('m',method,'a',amount_mmk) ORDER BY method),'[]')::text FROM refund_payouts WHERE request_id=%s;" % L(rid))

    def default_payouts(self, sale, amount):
        return self.j("SELECT coalesce(public.fin_refund_default_payouts(%s, NULL, %d)::text, 'null');" % (L(sale), amount))

    def disc_req_sql(self, ref, disc, reason='policy test discount', key=None, shop='shop-a'):
        return "SELECT public.fin_request_discount_approval(%s, %d, %d, %s, %s)::text;" % (L(shop), ref, disc, L(reason), L(key or self.key()))

    def line_of(self, sale):
        return self.q("SELECT id FROM sale_items WHERE sale_id=%s ORDER BY id LIMIT 1;" % L(sale))


def run(ctx):
    ctx['sql']("CREATE DATABASE %s TEMPLATE postgres;" % DB, 'p6-clone.log')
    t = P(ctx)
    sections = [setup, split_refunds, rounding, alternative_payout, price_adjust, drawer_and_change, offline_and_duplicates,
                discounts, discount_approval, discount_paths, isolation, review_fixes, drawer_race, drawer_closed]
    for s in sections:
        t.guard('p6--', 'section ' + s.__name__, lambda s=s: s(t))
    (t.run / 'p6-results.json').write_text(json.dumps(t.results, indent=1) + '\n')
    t.trace.close()


# ------------------------------------------------------------------------------------------------------------- setup
def setup(t):
    t.q("UPDATE inventory SET qty_base_units = 100000 WHERE shop_id IN ('shop-a','shop-b');")
    who_of = {v: k for k, v in fi.U.items()}
    for s in t.j("SELECT coalesce(json_agg(json_build_object('id',s.id,'auth',u.auth_id)),'[]')::text FROM shifts s JOIN users u ON u.id=s.cashier_id "
                 "WHERE s.ended_at IS NULL AND s.shop_id IN ('shop-a','shop-b');"):
        who = who_of.get(s['auth'])
        if who:
            t.q("SELECT public.fin_close_shift(%s, %d, 'p6 setup', NULL, NULL, %s)::text;" % (L(s['id']), t.expected(s['id']), L(t.key())), who)
    t.C1 = t.open_shift('c1', 100000)
    t.MG = t.open_shift('mgr', 100000)
    t.AD = t.open_shift('admin', 100000)
    t.C2 = t.open_shift('c2', 0)
    t.check('p600', 'fresh shifts: cashier 100000, manager 100000, admin 100000, cashier C2 0', '100000/100000/100000/0',
            [t.expected(x) for x in (t.C1, t.MG, t.AD, t.C2)], [t.expected(x) for x in (t.C1, t.MG, t.AD, t.C2)] == [100000, 100000, 100000, 0])


# ---------------------------------------------------------------------------------------------------- D1 split refunds
def split_refunds(t):
    pays = [{'method': 'CASH', 'amountMmk': 6000}, {'method': 'BANK_TRANSFER', 'amountMmk': 4000, 'reference': 'TRX-P6'}]
    s, _ = t.split('c1', t.C1, t.sale_items(10), pays)
    line = t.line_of(s['id'])
    exp0 = t.expected(t.C1)
    # partial refund: 3 of 10 units (3000) -> default 1800 cash + 1200 bank
    plan = t.j("SELECT public.fin_refund_plan(%s, %s)::text;" % (L(s['id']), J([{'saleItemId': line, 'qtyUnits': 3}])), 'c1')
    t.check('p601', 'D1 plan: 3 of 10 units of a 6000 cash + 4000 bank sale -> 3000, default payout CASH 1800 + BANK 1200',
            '3000 / CASH1800 BANK1200', (plan['totalMmk'], plan['defaultPayouts']),
            plan['totalMmk'] == 3000 and plan['defaultPayouts'] == [{'method': 'BANK_TRANSFER', 'amountMmk': 1200}, {'method': 'CASH', 'amountMmk': 1800}])
    r1 = t.req('c1', s['id'], [item('prod-1', 3, 3000, line, True, [('CASH', 1800), ('BANK_TRANSFER', 1200)])])
    t.approve('mgr', r1)
    t.check('p602', 'partial split refund approved: payouts CASH 1800 + BANK 1200; only the cash leaves the drawer',
            'CASH1800 BANK1200, drawer -1800', (t.payouts(r1), exp0 - t.expected(t.C1)),
            t.payouts(r1) == [{'m': 'BANK_TRANSFER', 'a': 1200}, {'m': 'CASH', 'a': 1800}] and exp0 - t.expected(t.C1) == 1800)
    st = t.j("SELECT public.fin_refund_payout_state(%s)::text;" % L(s['id']), 'mgr')
    t.check('p603', 'the bank payout is NOT paid until confirmed (PENDING_CONFIRMATION); cash is PAID at approval',
            'BANK PENDING_CONFIRMATION, CASH PAID', sorted((x['method'], x['status']) for x in st),
            sorted((x['method'], x['status']) for x in st) == [('BANK_TRANSFER', 'PENDING_CONFIRMATION'), ('CASH', 'PAID')])
    bank = [x for x in st if x['method'] == 'BANK_TRANSFER'][0]['id']
    cash = [x for x in st if x['method'] == 'CASH'][0]['id']
    t.refused('p604', 'a cashier cannot confirm a bank payout', "SELECT public.fin_confirm_refund_payout(%s, 'TRX-R1', %s);" % (L(bank), L(t.key())), 'c1', 'not permitted')
    t.refused('p605', 'a cash payout has nothing to confirm', "SELECT public.fin_confirm_refund_payout(%s, 'X', %s);" % (L(cash), L(t.key())), 'mgr', 'FIN_PAYOUT_INVALID')
    k = t.key()
    c1 = t.j("SELECT public.fin_confirm_refund_payout(%s, 'TRX-R1', %s)::text;" % (L(bank), L(k)), 'mgr')
    c2 = t.j("SELECT public.fin_confirm_refund_payout(%s, 'TRX-R1', %s)::text;" % (L(bank), L(k)), 'mgr')
    st = t.j("SELECT public.fin_refund_payout_state(%s)::text;" % L(s['id']), 'mgr')
    t.check('p606', 'bank payout confirmed with its reference (same key replays, never twice); status CONFIRMED; drawer unchanged',
            'CONFIRMED, replay, 1 row', ([x['status'] for x in st if x['method'] == 'BANK_TRANSFER'], c2['replayed'], t.q("SELECT count(*) FROM refund_payout_confirmations;")),
            [x['status'] for x in st if x['method'] == 'BANK_TRANSFER'] == ['CONFIRMED'] and c2['replayed'] is True and c1['replayed'] is False
            and t.q("SELECT count(*) FROM refund_payout_confirmations;") == '1' and exp0 - t.expected(t.C1) == 1800)
    t.refused('p607', 'a second confirmation of the same payout (new key) is refused', "SELECT public.fin_confirm_refund_payout(%s, 'TRX-R1b', %s);" % (L(bank), L(t.key())),
              'mgr', 'already confirmed')
    # second partial refund (3 more), then the rest (4): cumulative attribution follows the original shares exactly
    r2 = t.req('c1', s['id'], [item('prod-1', 3, 3000, line, True, [('CASH', 1800), ('BANK_TRANSFER', 1200)])])
    t.approve('mgr', r2)
    t.check('p608', 'multiple cumulative refunds: the full remainder (4 units, 4000) defaults to exactly what is left per method (CASH 2400 + BANK 1600)',
            'CASH2400 BANK1600', t.default_payouts(s['id'], 4000),
            t.default_payouts(s['id'], 4000) == [{'method': 'BANK_TRANSFER', 'amountMmk': 1600}, {'method': 'CASH', 'amountMmk': 2400}])
    t.refused('p609', 'a payout that does not follow the original methods (all 4000 by bank) is refused for a cashier (alternative payout)',
              t.req_sql(s['id'], [item('prod-1', 4, 4000, line, True, [('BANK_TRANSFER', 4000)])], t.key()), 'c1', 'FIN_REFUND_EXCEPTION_NOT_PERMITTED')
    r3 = t.req('c1', s['id'], [item('prod-1', 4, 4000, line, True, [('CASH', 2400), ('BANK_TRANSFER', 1600)])])
    t.approve('mgr', r3)
    tot = t.j("SELECT json_build_object('cash',sum(amount_mmk) FILTER (WHERE method='CASH'),'bank',sum(amount_mmk) FILTER (WHERE method='BANK_TRANSFER'))::text FROM refund_payouts WHERE sale_id=%s;" % L(s['id']))
    t.check('p610', 'FULL split refund (three refunds) returned exactly 6000 cash + 4000 bank; the drawer lost exactly the 6000 cash',
            'cash 6000 bank 4000, drawer -6000', (tot, exp0 - t.expected(t.C1)), tot == {'cash': 6000, 'bank': 4000} and exp0 - t.expected(t.C1) == 6000)
    t.refused('p611', 'nothing is left to refund: a further request is refused (never more than originally paid)',
              t.req_sql(s['id'], [item('prod-1', 1, 1000, line, True, [('CASH', 1000)])], t.key()), 'c1', 'exceeds what was sold')
    t.refused('p612', 'a split-sale refund without lines and payouts (released till) is refused',
              t.req_sql(t.split('c1', t.C1, t.sale_items(2), [{'method': 'CASH', 'amountMmk': 1000}, {'method': 'CARD', 'amountMmk': 1000}])[0]['id'],
                        [item('prod-1', 1, 1000)], t.key()), 'c1', 'FIN_REFUND_DETAIL_REQUIRED')
    rep = t.report('shop-a')
    t.check('p613', 'reports: refunds are attributed by payout method and net revenue is reduced by the refunded amount (report runs)',
            'report totals present', sorted(rep.keys())[:6], isinstance(rep, dict))
    # full refund in one request of a fresh 60/40 sale
    s2, _ = t.split('c1', t.C1, t.sale_items(10), pays)
    l2 = t.line_of(s2['id'])
    r4 = t.req('c1', s2['id'], [item('prod-1', 10, 10000, l2, True, [('CASH', 6000), ('BANK_TRANSFER', 4000)])])
    t.approve('mgr', r4)
    t.check('p614', 'FULL split refund in ONE request: 60,000-style example scaled (6000 cash + 4000 bank) -> CASH 6000 + BANK 4000',
            'CASH6000 BANK4000', t.payouts(r4), t.payouts(r4) == [{'m': 'BANK_TRANSFER', 'a': 4000}, {'m': 'CASH', 'a': 6000}])
    # no-restock line: stock unchanged, cost of goods not reversed
    s3, _ = t.split('c1', t.C1, t.sale_items(2), [{'method': 'CASH', 'amountMmk': 1000}, {'method': 'MOBILE_WALLET', 'amountMmk': 1000}])
    l3 = t.line_of(s3['id'])
    inv = t.inv('prod-1')
    r5 = t.req('c1', s3['id'], [item('prod-1', 1, 1000, l3, False, [('CASH', 500), ('MOBILE_WALLET', 500)])])
    t.approve('mgr', r5)
    rl = t.j("SELECT json_build_object('restocked',bool_and(restocked),'cost',min(cost_mmk))::text FROM refund_lines WHERE request_id=%s;" % L(r5))
    t.check('p615', 'no-restock split refund: stock unchanged (RETURN_IN then RETURN_NO_RESTOCK), refund line not restocked with its cost kept',
            'inv same, restocked false, cost 600', (t.inv('prod-1') - inv, rl), t.inv('prod-1') == inv and rl['restocked'] is False and rl['cost'] == 600)


# ---------------------------------------------------------------------------------------------------- D1 rounding
def rounding(t):
    s, _ = t.split('c1', t.C1, t.sale_items(3), [{'method': 'CASH', 'amountMmk': 1001}, {'method': 'BANK_TRANSFER', 'amountMmk': 1000},
                                                  {'method': 'MOBILE_WALLET', 'amountMmk': 999}])
    line = t.line_of(s['id'])
    got = []
    for _ in range(3):
        d = t.default_payouts(s['id'], 1000)
        got.append({x['method']: x['amountMmk'] for x in d})
        rid = t.req('c1', s['id'], [item('prod-1', 1, 1000, line, True, [(x['method'], x['amountMmk']) for x in d])])
        t.approve('mgr', rid)
    want = [{'CASH': 334, 'BANK_TRANSFER': 333, 'MOBILE_WALLET': 333}, {'CASH': 333, 'BANK_TRANSFER': 334, 'MOBILE_WALLET': 333},
            {'CASH': 334, 'BANK_TRANSFER': 333, 'MOBILE_WALLET': 333}]
    t.check('p620', 'deterministic rounding over three 1000 refunds of a 1001/1000/999 sale: largest remainder each time; totals exactly the original',
            want, got, got == want and sum(sum(g.values()) for g in got) == 3000)


# ----------------------------------------------------------------------------------------------- D2 alternative payout
def alternative_payout(t):
    pays = [{'method': 'CASH', 'amountMmk': 6000}, {'method': 'BANK_TRANSFER', 'amountMmk': 4000}]
    s, _ = t.split('mgr', t.MG, t.sale_items(10), pays)
    line = t.line_of(s['id'])
    exp0 = t.expected(t.MG)
    rid = t.req('mgr', s['id'], [item('prod-1', 10, 10000, line, True, [('CASH', 10000)])])
    a = t.approval(rid, 'REFUND_ALT_PAYOUT')
    t.check('p630', 'D2 a manager proposes paying everything back in cash: an ALT_PAYOUT approval request records original (6000 cash + 4000 bank) and proposed (10000 cash)',
            'REQUESTED, original/proposed recorded, requester', a and (a['status'], a['details'], a['requested_by']),
            a is not None and a['status'] == 'REQUESTED'
            and a['details']['original'] == [{'method': 'BANK_TRANSFER', 'amountMmk': 4000}, {'method': 'CASH', 'amountMmk': 6000}]
            and a['details']['proposed'] == [{'method': 'CASH', 'amountMmk': 10000}] and a['requested_by'] == 'u-mgr-a')
    t.refused('p631', 'the refund cannot be approved while the alternative payout is undecided', t.approve_sql(rid, t.key()), 'admin', 'FIN_REFUND_EXCEPTION_PENDING')
    t.refused('p632', 'no self-approval: the requesting manager cannot decide the alternative payout', t.decide_sql(a['id'], 'APPROVE'), 'mgr', 'FIN_APPROVAL_SELF')
    t.refused('p633', 'a cashier cannot decide it', t.decide_sql(a['id'], 'APPROVE'), 'c1', 'FIN_APPROVER_NOT_ELIGIBLE')
    t.refused('p634', 'a manager of ANOTHER shop cannot decide it', t.decide_sql(a['id'], 'APPROVE'), 'mgrb', 'FIN_APPROVER_NOT_ELIGIBLE')
    t.refused('p635', 'wrong organization: a manager of another org cannot see or decide it', t.decide_sql(a['id'], 'APPROVE'), 'xmgr', 'FIN_APPROVAL_NOT_FOUND')
    t.refused('p636', 'a rejection needs a reason', t.decide_sql(a['id'], 'REJECT', ''), 'admin', 'needs a reason')
    k = t.key()
    d1 = t.j(t.decide_sql(a['id'], 'APPROVE', 'customer has no bank account', k), 'admin')
    d2 = t.j(t.decide_sql(a['id'], 'APPROVE', 'customer has no bank account', k), 'admin')
    t.check('p637', 'the Shop Admin (org ADMIN) approves; the same key replays the decision', 'APPROVED by u-admin, replayed',
            (d1['approval']['status'], d1['approval']['decidedBy'], d2['replayed']),
            d1['approval']['status'] == 'APPROVED' and d1['approval']['decidedBy'] == 'u-admin' and d2['replayed'] is True)
    t.refused('p638', 'a decided approval cannot be decided again (new key)', t.decide_sql(a['id'], 'REJECT', 'changed my mind'), 'admin', 'FIN_APPROVAL_DECIDED')
    t.refused('p639', 'the approval row cannot be changed directly (immutable decision)', "UPDATE fin_approvals SET status='REJECTED' WHERE id=%s;" % L(a['id']),
              None, 'FIN_RECORD_IMMUTABLE')
    t.approve('admin', rid)
    pm = t.j("SELECT json_agg(json_build_object('m',method,'a',a) ORDER BY method)::text FROM public.fin_refund_prior_methods(%s, NULL);" % L(s['id']))
    t.check('p640', 'the approved alternative payout is paid in cash (10000 leaves the drawer) while the refund stays ATTRIBUTED to the original methods',
            'payout CASH10000, drawer -10000, attribution BANK4000 CASH6000', (t.payouts(rid), exp0 - t.expected(t.MG), pm),
            t.payouts(rid) == [{'m': 'CASH', 'a': 10000}] and exp0 - t.expected(t.MG) == 10000
            and pm == [{'m': 'BANK_TRANSFER', 'a': 4000}, {'m': 'CASH', 'a': 6000}])
    # a rejected alternative payout blocks the refund
    s2, _ = t.split('mgr', t.MG, t.sale_items(2), [{'method': 'CASH', 'amountMmk': 1000}, {'method': 'BANK_TRANSFER', 'amountMmk': 1000}])
    l2 = t.line_of(s2['id'])
    r2 = t.req('mgr', s2['id'], [item('prod-1', 2, 2000, l2, True, [('CASH', 2000)])])
    a2 = t.approval(r2, 'REFUND_ALT_PAYOUT')
    t.decide('admin', a2['id'], 'REJECT', 'bank refund is possible')
    t.refused('p641', 'a REJECTED alternative payout: the refund cannot be approved', t.approve_sql(r2, t.key()), 'admin', 'FIN_REFUND_EXCEPTION_PENDING')
    # Shop Admin = fin:approve_exception for THAT shop (or an org ADMIN): a grant is scoped by the user's own shop
    s3, _ = t.split('mgr', t.MG, t.sale_items(2), [{'method': 'CASH', 'amountMmk': 1000}, {'method': 'BANK_TRANSFER', 'amountMmk': 1000}])
    r3 = t.req('mgr', s3['id'], [item('prod-1', 2, 2000, t.line_of(s3['id']), True, [('CASH', 2000)])])
    a3 = t.approval(r3, 'REFUND_ALT_PAYOUT')
    t.q("UPDATE users SET granted_permissions = array_append(coalesce(granted_permissions,'{}'), 'fin:approve_exception') WHERE id IN ('u-mgr-b','u-cash-a2');", "admin")
    t.refused('p642', 'fin:approve_exception held by manager B (shop-b) does not make them a Shop Admin of shop-a', t.decide_sql(a3['id'], 'APPROVE'), 'mgrb', 'FIN_APPROVER_NOT_ELIGIBLE')
    d3 = t.decide('c2', a3['id'])
    t.check('p643', 'a user granted fin:approve_exception for shop-a (here cashier A2) is a Shop Admin of shop-a and may decide', 'APPROVED by u-cash-a2',
            (d3['approval']['status'], d3['approval']['decidedBy']), d3['approval']['status'] == 'APPROVED' and d3['approval']['decidedBy'] == 'u-cash-a2')
    t.q("UPDATE users SET granted_permissions = array_remove(granted_permissions, 'fin:approve_exception') WHERE id IN ('u-mgr-b','u-cash-a2');", "admin")
    # the default can be revoked per user: an ADMIN without fin:approve_exception is no Shop Admin
    s4, _ = t.split('mgr', t.MG, t.sale_items(2), [{'method': 'CASH', 'amountMmk': 1000}, {'method': 'BANK_TRANSFER', 'amountMmk': 1000}])
    r4 = t.req('mgr', s4['id'], [item('prod-1', 2, 2000, t.line_of(s4['id']), True, [('CASH', 2000)])])
    a4 = t.approval(r4, 'REFUND_ALT_PAYOUT')
    t.q("UPDATE users SET revoked_permissions = array_append(coalesce(revoked_permissions,'{}'), 'fin:approve_exception') WHERE id='u-admin';", "admin")
    t.refused('p644', 'an organization ADMIN whose fin:approve_exception was revoked is not a Shop Admin', t.decide_sql(a4['id'], 'APPROVE'), 'admin', 'FIN_APPROVER_NOT_ELIGIBLE')
    t.q("UPDATE users SET revoked_permissions = array_remove(revoked_permissions, 'fin:approve_exception') WHERE id='u-admin';", "admin")


# ---------------------------------------------------------------------------------------------------- D3 / P-2 price
def price_adjust(t):
    s, _ = t.sale('c1', t.C1, t.sale_items(4), 'CASH', 4000)
    line = t.line_of(s['id'])
    t.refused('p650', 'P-2: a cashier cannot propose a refund price other than the paid price (1000 per unit)',
              t.req_sql(s['id'], [item('prod-1', 1, 800, line, True)], t.key()), 'c1', 'FIN_REFUND_EXCEPTION_NOT_PERMITTED')
    rid = t.req('mgr', s['id'], [item('prod-1', 1, 800, line, True)])
    a = t.approval(rid, 'REFUND_PRICE_ADJUST')
    t.check('p651', 'P-2: a manager-adjusted refund price (800 for a unit paid 1000) becomes a PRICE_ADJUST approval request with default and proposed',
            'REQUESTED default 1000 proposed 800', a and (a['status'], a['details']['lines']),
            a is not None and a['status'] == 'REQUESTED' and a['details']['lines'] == [{'saleItemId': line, 'qtyUnits': 1, 'defaultMmk': 1000, 'proposedMmk': 800}])
    t.refused('p652', 'the adjusted refund cannot be approved before the Shop Admin decision', t.approve_sql(rid, t.key()), 'admin', 'FIN_REFUND_EXCEPTION_PENDING')
    t.refused('p653', 'a manager (not Shop Admin) cannot decide a price adjustment', t.decide_sql(a['id'], 'APPROVE'), 'mgrb', 'FIN_APPROVER_NOT_ELIGIBLE')
    t.decide('admin', a['id'])
    t.approve('admin', rid)
    amt = t.q("SELECT sum(amount_mmk) FROM refund_lines WHERE request_id=%s;" % L(rid))
    t.check('p654', 'after the Shop Admin approval the adjusted refund (800) is recorded', '800', amt, amt == '800')
    rid2 = t.req('c1', s['id'], [item('prod-1', 1, 1000, line, True)])
    t.approve('mgr', rid2)
    t.check('p655', 'the default price (1000) needs no approval: no approval row, approved by a manager',
            'no approval, approved', (t.approval(rid2, 'REFUND_PRICE_ADJUST'), t.q("SELECT status FROM refund_void_requests WHERE id=%s;" % L(rid2))),
            t.approval(rid2, 'REFUND_PRICE_ADJUST') is None and t.q("SELECT status FROM refund_void_requests WHERE id=%s;" % L(rid2)) == 'APPROVED')
    # discounted sale: the default refund price is the paid price after the discount (manager 5% cart discount)
    s2, _ = t.sale('mgr', t.MG, t.sale_items(4), 'CASH', 4000, disc=5)
    l2 = t.line_of(s2['id'])
    plan = t.j("SELECT public.fin_refund_plan(%s, %s)::text;" % (L(s2['id']), J([{'saleItemId': l2, 'qtyUnits': 1}])), 'mgr')
    t.check('p656', 'P-2: the default refund of one unit of a 5%-discounted 4000 sale (3800) is 950, the actual paid price', '950',
            plan['lines'][0]['defaultMmk'], plan['lines'][0]['defaultMmk'] == 950)


# -------------------------------------------------------------------------------------------- f125 drawer / f10 change
def drawer_and_change(t):
    s, _ = t.sale('c2', t.C2, t.sale_items(1), 'CASH', 1000)
    t.q("SELECT public.fin_record_cash_movement(%s, 'PAY_OUT', 1000, 'p6 drawer emptied', NULL, NULL, %s)::text;" % (L(t.C2), L(t.key())), 'mgr')
    line = t.line_of(s['id'])
    rid = t.req('c2', s['id'], [item('prod-1', 1, 1000, line, True)])
    t.check('p660', 'f125 setup: the sale\'s shift holds 0 MMK expected cash', 0, t.expected(t.C2), t.expected(t.C2) == 0)
    t.refused('p661', 'f125: a cash refund that would take the drawer below zero is refused at approval', t.approve_sql(rid, t.key()), 'mgr', 'FIN_DRAWER_INSUFFICIENT')
    t.q("SELECT public.fin_record_cash_movement(%s, 'PAY_IN', 1000, 'p6 float', NULL, NULL, %s)::text;" % (L(t.C2), L(t.key())), 'c2')
    t.approve('mgr', rid)
    t.check('p662', 'f125: with 1000 in the drawer the same refund is approved and the drawer reaches exactly 0', 0, t.expected(t.C2), t.expected(t.C2) == 0)
    t.refused('p663', 'f10: a single OTHER (non-cash) sale with change (paid 5000 for 1000) is refused on every path',
              t.sale_sql(t.C1, t.sale_items(1), 'OTHER', 5000, key=t.key()), 'c1', 'FIN_NON_CASH_CHANGE')
    t.refused('p664', 'f10: change on a non-cash split payment is refused (PFIN-D)', t.split_sql(t.C1, t.sale_items(1), [{'method': 'CARD', 'amountMmk': 1000, 'tenderedMmk': 1500}], key=t.key()),
              'c1', 'FIN_PAYMENTS_INVALID')
    ok, _ = t.sale('c1', t.C1, t.sale_items(1), 'OTHER', 1000)
    t.check('p665', 'f10: a non-cash sale for exactly the amount due is accepted (change 0)', 0, ok['changeMmk'], ok['changeMmk'] == 0)


# ------------------------------------------------------------------------------------- offline, duplicates, isolation
def offline_and_duplicates(t):
    s, _ = t.sale('c1', t.C1, t.sale_items(2), 'CASH', 2000)
    line = t.line_of(s['id'])
    off = {'x-orvix-offline': {'capabilityId': '00000000-0000-4000-8000-000000000000', 'deviceSeq': 1}}
    t.with_headers(off, lambda: t.refused('p670', 'offline refund refusal: a refund request recorded offline is refused, nothing saved',
                                          t.req_sql(s['id'], [item('prod-1', 1, 1000, line, True)], t.key()), 'c1', 'FIN_REFUND_OFFLINE'))
    t.with_headers(off, lambda: t.refused('p671', 'offline: a void request recorded offline is refused too', t.req_sql(s['id'], None, t.key(), 'VOID'), 'c1', 'FIN_REFUND_OFFLINE'))
    k = t.key()
    r1 = t.q(t.req_sql(s['id'], [item('prod-1', 1, 1000, line, True)], k), 'c1')
    r2 = t.q(t.req_sql(s['id'], [item('prod-1', 1, 1000, line, True)], k), 'c1')
    t.check('p672', 'duplicate refund submission (same key): one request, the second call replays it', 'same id, 1 request',
            (r1 == r2, t.q("SELECT count(*) FROM refund_void_requests WHERE sale_id=%s;" % L(s['id']))),
            r1 == r2 and t.q("SELECT count(*) FROM refund_void_requests WHERE sale_id=%s;" % L(s['id'])) == '1')
    ak = t.key()
    t.approve('mgr', r1, ak)
    t.approve('mgr', r1, ak)
    n = t.q("SELECT count(*)||':'||sum(amount_mmk) FROM refund_lines WHERE request_id=%s;" % L(r1))
    t.check('p673', 'duplicate approval (same key) executes the payout once: one refund line of 1000', '1:1000', n, n == '1:1000')
    t.with_headers(off, lambda: t.refused('p675', 'offline: an approval decision cannot be made offline', t.decide_sql('fa-none', 'APPROVE'), 'admin', 'FIN_APPROVAL_OFFLINE'))


# ------------------------------------------------------------------------------------------------- E discounts (rules)
def discounts(t):
    cart = t.sale_items(10)          # 10000 MMK reference
    t.refused('p680', 'E1 a cashier cannot apply a discretionary discount on their own (1%): refused, nothing saved',
              t.sale_sql(t.C1, cart, 'CASH', 10000, 1, t.key()), 'c1', 'DISCOUNT_APPROVAL_REQUIRED')
    t.refused('p681', 'E1 a cashier cannot complete a 100%-discount sale on their own', t.sale_sql(t.C1, cart, 'CASH', 0, 100, t.key()), 'c1', 'DISCOUNT_APPROVAL_REQUIRED')
    s0, _ = t.sale('c1', t.C1, cart, 'CASH', 10000, disc=0)
    t.check('p682', 'boundary 0%: a cashier sale without discount is accepted', '10000', s0['totalMmk'], s0['totalMmk'] == 10000)
    res = {}
    for who, shift in (('mgr', t.MG), ('admin', t.AD)):
        for pct, ok in ((4.99, True), (5, True), (5.01, False), (50, False), (100, False)):
            sql = t.sale_sql(shift, cart, 'CASH', 10000, pct, t.key())
            if ok:
                r = t.j(sql, who)['sale']
                res[(who, pct)] = (r['discountMmk'], r['totalMmk'])
            else:
                before = t.state()
                e = t.err(sql, who)
                res[(who, pct)] = (e or 'SUCCEEDED')[:40] + ('' if t.state() == before else ' CHANGED')
    want_ok = {('mgr', 4.99): (499, 9501), ('mgr', 5): (500, 9500), ('admin', 4.99): (499, 9501), ('admin', 5): (500, 9500)}
    good = all(res[k] == v for k, v in want_ok.items()) and all(isinstance(res[(w, p)], str) and res[(w, p)].startswith('DISCOUNT_APPROVAL_REQUIRED')
                                                                 for w in ('mgr', 'admin') for p in (5.01, 50, 100))
    t.check('p683', 'E2/E3 boundaries for a manager and an org admin: 4.99% and exactly 5% on their own; 5.01%, 50%, 100% need approval (nothing saved)',
            'ok/ok/refused/refused/refused', {'%s %s' % k: v for k, v in res.items()}, good)
    t.refused('p684', 'E8 cumulative: line discount 3% + cart discount 3% (5.91% effective) cannot pass the 5% line', t.sale_sql(t.MG, t.sale_items(10, disc=3), 'CASH', 10000, 3, t.key()),
              'mgr', 'DISCOUNT_APPROVAL_REQUIRED')
    t.refused('p685', 'E8 cumulative: a manual price override 1000 -> 960 (4%) plus a 2% cart discount (>5%) needs approval',
              t.sale_sql(t.MG, [{'product_id': 'prod-1', 'qty': 10, 'unit_price_mmk': 960}], 'CASH', 10000, 2, t.key()), 'mgr', 'DISCOUNT_APPROVAL_REQUIRED')
    ok, _ = t.sale('mgr', t.MG, [{'product_id': 'prod-1', 'qty': 10, 'unit_price_mmk': 960}], 'CASH', 10000, disc=1)
    t.check('p686', 'E8 a 4% override + 1% cart (4.96% effective) stays within a manager\'s 5%', 'accepted', ok['totalMmk'], ok['totalMmk'] == 9504)
    t.refused('p687', 'E1 a cashier cannot cut a price by override either (no override permission)', t.sale_sql(t.C1, [{'product_id': 'prod-1', 'qty': 1, 'unit_price_mmk': 900}], 'CASH', 1000, 0, t.key()),
              'c1', 'not permitted to override')
    t.q("UPDATE users SET revoked_permissions = array_append(coalesce(revoked_permissions,'{}'), 'pos:apply_discount') WHERE id='u-mgr-a';", "admin")
    t.refused('p688', 'a manager whose pos:apply_discount was revoked has no own 5% either', t.sale_sql(t.MG, cart, 'CASH', 10000, 2, t.key()), 'mgr', 'DISCOUNT_APPROVAL_REQUIRED')
    t.q("UPDATE users SET revoked_permissions = array_remove(revoked_permissions, 'pos:apply_discount') WHERE id='u-mgr-a';", "admin")


def discount_approval(t):
    cart = t.sale_items(10)
    a = t.j(t.disc_req_sql(10000, 5000, 'regular customer, damaged box'), 'mgr')['approval']
    t.check('p690', 'E4/E7 a manager asks for 50%: the request records amount, percentage, reference price, reason, requester',
            '5000 / 50 / 10000 / reason / u-mgr-a', (a['details'], a['reason'], a['requestedBy'], a['status']),
            a['details']['discountMmk'] == 5000 and float(a['details']['pct']) == 50 and a['details']['referenceSubtotalMmk'] == 10000
            and a['requestedBy'] == 'u-mgr-a' and a['status'] == 'REQUESTED')
    t.refused('p691', 'E5 no self-approval of an exceptional discount', t.decide_sql(a['id'], 'APPROVE'), 'mgr', 'FIN_APPROVAL_SELF')
    t.refused('p692', 'a cashier cannot approve it', t.decide_sql(a['id'], 'APPROVE'), 'c1', 'FIN_APPROVER_NOT_ELIGIBLE')
    t.refused('p693', 'a manager of another shop cannot approve it', t.decide_sql(a['id'], 'APPROVE'), 'mgrb', 'FIN_APPROVER_NOT_ELIGIBLE')
    t.refused('p694', 'E6/E9 while it is pending the sale cannot be committed with it', t.sale_sql(t.MG, cart, 'CASH', 10000, 50, t.key()), 'mgr', 'DISCOUNT_APPROVAL_REQUIRED')
    t.with_headers({'x-orvix-discount-approval': a['id']},
                   lambda: t.refused('p695', 'E9 naming a still-pending approval does not help', t.sale_sql(t.MG, cart, 'CASH', 10000, 50, t.key()), 'mgr', 'not approved'))
    t.decide('admin', a['id'])
    hdr = {'x-orvix-discount-approval': a['id']}
    t.with_headers(hdr, lambda: t.refused('p696', 'the approval is bound to its cart: a different reference amount is refused',
                                          t.sale_sql(t.MG, t.sale_items(9), 'CASH', 9000, 50, t.key()), 'mgr', 'is for a cart of 10000'))
    t.with_headers(hdr, lambda: t.refused('p697', 'the approval is bound to its seller: another seller cannot use it',
                                          t.sale_sql(t.AD, cart, 'CASH', 10000, 50, t.key()), 'admin', 'another seller'))
    t.with_headers(hdr, lambda: t.refused('p698', 'more discount than approved is refused (60% > 50%)', t.sale_sql(t.MG, cart, 'CASH', 10000, 60, t.key()), 'mgr', 'covers 5000'))
    s = t.with_headers(hdr, lambda: t.sale('mgr', t.MG, cart, 'CASH', 10000, disc=50)[0])
    row = t.j("SELECT row_to_json(f)::text FROM fin_approvals f WHERE id=%s;" % L(a['id']))
    t.check('p699', 'E4/E7 with the independent Shop Admin approval the 50% sale commits; the approval records approver, time and the one sale it was used for',
            'total 5000, consumed by the sale, decided by u-admin', (s['totalMmk'], row['consumed_sale_id'] == s['id'], row['decided_by']),
            s['totalMmk'] == 5000 and row['consumed_sale_id'] == s['id'] and row['decided_by'] == 'u-admin' and row['decided_at'] is not None)
    t.with_headers(hdr, lambda: t.refused('p6a0', 'single use: the same approval cannot discount a second sale', t.sale_sql(t.MG, cart, 'CASH', 10000, 50, t.key()), 'mgr', 'already used'))
    # cashier 100% with approval; a manager may approve a cashier's discount only up to 5%
    b = t.j(t.disc_req_sql(1000, 1000, 'staff meal (100%)'), 'c1')['approval']
    t.refused('p6a1', 'a cashier\'s 100% request: a manager (not Shop Admin) cannot approve more than 5%', t.decide_sql(b['id'], 'APPROVE'), 'mgr', 'FIN_APPROVER_NOT_ELIGIBLE')
    t.decide('admin', b['id'])
    s100 = t.with_headers({'x-orvix-discount-approval': b['id']}, lambda: t.sale('c1', t.C1, t.sale_items(1), 'CASH', 0, disc=100)[0])
    t.check('p6a2', 'E1/E4 a cashier\'s 100% sale commits ONLY with a Shop Admin approval (total 0, no payment row)', 'total 0',
            s100['totalMmk'], s100['totalMmk'] == 0)
    c = t.j(t.disc_req_sql(10000, 300, 'loyalty 3%'), 'c1')['approval']
    t.decide('mgr', c['id'])
    s3 = t.with_headers({'x-orvix-discount-approval': c['id']}, lambda: t.sale('c1', t.C1, cart, 'CASH', 10000, disc=3)[0])
    t.check('p6a3', 'a cashier\'s 3% discount approved by a manager of the shop (5% or less) commits', 'total 9700', s3['totalMmk'], s3['totalMmk'] == 9700)
    d = t.j(t.disc_req_sql(10000, 500, 'no approver test'), 'c1')['approval']
    t.check('p6a4', 'E6 with no eligible decision the request just stays pending (nothing is executed)', 'REQUESTED, unconsumed',
            t.j("SELECT json_build_object('s',status,'c',consumed_sale_id)::text FROM fin_approvals WHERE id=%s;" % L(d['id'])),
            t.j("SELECT json_build_object('s',status,'c',consumed_sale_id)::text FROM fin_approvals WHERE id=%s;" % L(d['id'])) == {'s': 'REQUESTED', 'c': None})
    e = t.j(t.disc_req_sql(10000, 2000, 'offline test'), 'mgr')['approval']
    t.decide('admin', e['id'])
    t.with_headers({'x-orvix-discount-approval': e['id'], 'x-orvix-offline': {'capabilityId': '00000000-0000-4000-8000-000000000000', 'deviceSeq': 1}},
                   lambda: t.refused('p6a5', 'E11 an approval-required discount never takes effect offline (even with an approval)',
                                     t.sale_sql(t.MG, cart, 'CASH', 10000, 20, t.key()), 'mgr', 'DISCOUNT_APPROVAL_OFFLINE'))
    t.with_headers({'x-orvix-offline': {'capabilityId': '00000000-0000-4000-8000-000000000000', 'deviceSeq': 1}},
                   lambda: t.refused('p6a6', 'E11 a discount approval cannot be requested offline', t.disc_req_sql(10000, 600, 'offline'), 'c1', 'DISCOUNT_APPROVAL_OFFLINE'))
    k = t.key()
    x1 = t.j(t.disc_req_sql(10000, 700, 'same key', k), 'c1')
    x2 = t.j(t.disc_req_sql(10000, 700, 'same key', k), 'c1')
    t.check('p6a7', 'a discount request replays under its key (one row)', 'same id, replayed', (x1['approval']['id'] == x2['approval']['id'], x2['replayed']),
            x1['approval']['id'] == x2['approval']['id'] and x2['replayed'] is True)


def discount_paths(t):
    cart = t.sale_items(10)
    args = {'p_shop_id': 'shop-a', 'p_shift_id': t.C1, 'p_payment_method': 'CASH', 'p_paid_mmk': 10000, 'p_cart_discount_pct': 10, 'p_items': cart,
            'p_created_at': None}
    k = t.key7()
    t.refused('p6b0', 'E12 the executor path (op_execute, every current client) cannot bypass the rule: cashier 10% refused',
              "SELECT public.op_execute(%s, 'complete_sale', %s, 'u-cash-a1')::text;" % (L(k), J(args)), 'c1', 'DISCOUNT_APPROVAL_REQUIRED')
    t.refused('p6b1', 'E12 the split-payment path cannot bypass it either', t.split_sql(t.C1, cart, [{'method': 'CASH', 'amountMmk': 4500}, {'method': 'CARD', 'amountMmk': 4500}],
                                                                                         disc=10, key=t.key()), 'c1', 'DISCOUNT_APPROVAL_REQUIRED')
    t.refused('p6b2', 'E12 an old client calling complete_sale directly (no approval header) cannot bypass it', t.sale_sql(t.C1, cart, 'CASH', 10000, 10, t.key()),
              'c1', 'DISCOUNT_APPROVAL_REQUIRED')
    t.refused('p6b3', 'a user cannot write an approval row directly (no INSERT privilege)',
              "INSERT INTO fin_approvals (id, org_id, shop_id, kind, details, reason, requested_by, requested_at, status, decided_by, decided_at, expires_at) "
              "VALUES ('fa-x','org-test','shop-a','DISCOUNT','{}','forged','u-cash-a1',now(),'APPROVED','u-admin',now(),now()+interval '1 hour');", 'c1', 'permission denied')


def isolation(t):
    seen = t.j("SELECT json_build_object('fa',(SELECT count(*) FROM fin_approvals),'rpc',(SELECT count(*) FROM refund_payout_confirmations))::text;", 'xmgr')
    t.check('p6c0', 'wrong organization: another org sees none of org-test\'s approvals or payout confirmations', {'fa': 0, 'rpc': 0}, seen, seen == {'fa': 0, 'rpc': 0})
    shopb = t.j("SELECT json_build_object('fa',(SELECT count(*) FROM fin_approvals WHERE shop_id='shop-a'))::text;", 'mgrb')
    t.check('p6c1', 'same org, other shop: manager B sees no shop-a approvals', {'fa': 0}, shopb, shopb == {'fa': 0})
    t.refused('p6c2', 'wrong organization: a discount approval cannot be requested for another org\'s shop', t.disc_req_sql(10000, 1000, 'x', shop='shop-a'), 'xmgr',
              'not permitted to sell')
    t.refused('p6c3', 'wrong organization: refund plan of another org\'s sale', "SELECT public.fin_refund_plan('sale-unrel', '[]');", 'mgr', 'not found')
    fns = t.q("SELECT coalesce(string_agg(p.oid::regprocedure::text, ', '), '') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prosecdef "
              "AND (p.proname LIKE 'fin\\_%' OR p.proname LIKE 'net\\_%') AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%');")
    t.check('p6c4', 'SECURITY DEFINER safety: every fin_* / net_* definer function pins its search_path', '(none)', fns or '(none)', fns == '')
    anon = t.q("SELECT coalesce(string_agg(p.oid::regprocedure::text, ', '), '') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace "
               "AND p.proname IN ('fin_decide_approval','fin_request_discount_approval','fin_confirm_refund_payout','fin_refund_plan','fin_refund_payout_state',"
               "'fin_discount_authorize','fin_refund_policy') AND has_function_privilege('anon', p.oid, 'EXECUTE');")
    t.check('p6c5', 'none of the new functions is executable by anon', '(none)', anon or '(none)', anon == '')


# ------------------------------------------------------------------------------------- independent review fixes (R1-R2)
def review_fixes(t):
    # R1-F1: several methods already got back more than their proportional share -> the old allocator returned NULL
    s, _ = t.split('c1', t.C1, t.sale_items(10), [{'method': 'CASH', 'amountMmk': 3500}, {'method': 'BANK_TRANSFER', 'amountMmk': 2500},
                                                   {'method': 'MOBILE_WALLET', 'amountMmk': 4000}])
    line = t.line_of(s['id'])
    t.q("ALTER TABLE refund_void_requests DISABLE TRIGGER zzg_refund_policy_ins, DISABLE TRIGGER zzg_refund_exceptions;"
        "INSERT INTO refund_void_requests (id, sale_id, shop_id, type, reason, created_by, items, status) VALUES ('rvr-p6-f1', %s, 'shop-a', 'PARTIAL', "
        "'fixture: an earlier refund attributed BANK 91 / CASH 14 / WALLET 895', 'u-mgr-a', %s, 'APPROVED');"
        "ALTER TABLE refund_void_requests ENABLE TRIGGER zzg_refund_policy_ins, ENABLE TRIGGER zzg_refund_exceptions;"
        % (L(s['id']), J([item('prod-1', 1, 1000, line, True, [('BANK_TRANSFER', 91), ('CASH', 14), ('MOBILE_WALLET', 895)])])))
    d = t.default_payouts(s['id'], 1000)
    t.check('p6d0', 'R1-F1 a default exists even when two methods already got back more than their share (old allocator: NULL); exact and within what is left',
            '[BANK_TRANSFER 314, CASH 686]', d, d == [{'method': 'BANK_TRANSFER', 'amountMmk': 314}, {'method': 'CASH', 'amountMmk': 686}])
    rid = t.req('c1', s['id'], [item('prod-1', 1, 1000, line, True, [('BANK_TRANSFER', 314), ('CASH', 686)])])
    t.approve('mgr', rid)
    t.check('p6d1', 'R1-F1 that default is a normal refund (no approval needed) and is paid exactly so', 'BANK314 CASH686, no approval',
            (t.payouts(rid), t.approval(rid, 'REFUND_ALT_PAYOUT')), t.payouts(rid) == [{'m': 'BANK_TRANSFER', 'a': 314}, {'m': 'CASH', 'a': 686}]
            and t.approval(rid, 'REFUND_ALT_PAYOUT') is None)
    # R1-F3: a single non-cash (OTHER) sale: the refund records its payout, which stays unpaid until confirmed
    so, _ = t.sale('c1', t.C1, t.sale_items(1), 'OTHER', 1000)
    r3 = t.req('c1', so['id'], [item('prod-1', 1, 1000, t.line_of(so['id']), True)])
    t.approve('mgr', r3)
    st = t.j("SELECT public.fin_refund_payout_state(%s)::text;" % L(so['id']), 'mgr')
    t.check('p6d2', 'R1-F3 a refund of a single non-cash sale records its payout (OTHER 1000) as NOT paid until confirmed',
            'OTHER 1000 PENDING_CONFIRMATION', [(x['method'], x['amountMmk'], x['status']) for x in st],
            [(x['method'], x['amountMmk'], x['status']) for x in st] == [('OTHER', 1000, 'PENDING_CONFIRMATION')])
    sc, _ = t.sale('c1', t.C1, t.sale_items(1), 'CASH', 1000)
    exp0 = t.expected(t.C1)
    r4 = t.req('c1', sc['id'], [item('prod-1', 1, 1000, t.line_of(sc['id']), True)])
    t.approve('mgr', r4)
    t.check('p6d3', 'R1-F3 a single CASH sale\'s refund records a CASH payout and the drawer drops exactly once (1000)',
            'CASH 1000, -1000', (t.payouts(r4), exp0 - t.expected(t.C1)), t.payouts(r4) == [{'m': 'CASH', 'a': 1000}] and exp0 - t.expected(t.C1) == 1000)
    # R1-F6 / F7
    s7, _ = t.split('mgr', t.MG, t.sale_items(2), [{'method': 'CASH', 'amountMmk': 1000}, {'method': 'BANK_TRANSFER', 'amountMmk': 1000}])
    l7 = t.line_of(s7['id'])
    t.refused('p6d4', 'R1-F7 an alternative payout by a method the sale never used (CARD) is refused',
              t.req_sql(s7['id'], [item('prod-1', 2, 2000, l7, True, [('CARD', 2000)])], t.key()), 'mgr', 'FIN_REFUND_METHOD_INVALID')
    t.refused('p6d5', 'R1-F6 an exception request with a reason under 3 characters gets a clear refusal (not a constraint error)',
              "SELECT public.create_refund_void_request(%s, 'PARTIAL', 'ok', %s, NULL, NULL, %s);" % (L(s7['id']), J([item('prod-1', 2, 2000, l7, True, [('CASH', 2000)])]), L(t.key())),
              'mgr', 'FIN_REFUND_REASON_REQUIRED')
    # R2-L1: a manager may decide a cashier's discount only when it does not need a Shop Admin (exact integer test)
    a = t.j(t.disc_req_sql(1999999, 100000, 'R2-L1 rounding edge'), 'c1')['approval']
    t.refused('p6d6', 'R2-L1 100,000 of 1,999,999 (5.0000025%, stored as 5.0000) needs a Shop Admin: a manager is not eligible',
              t.decide_sql(a['id'], 'APPROVE'), 'mgr', 'FIN_APPROVER_NOT_ELIGIBLE')
    # R2-L4: cashiers see only their own requests
    seen = t.q("SELECT count(*) FROM fin_approvals WHERE requested_by = 'u-cash-a1';", 'c2')
    own = t.q("SELECT count(*) > 0 FROM fin_approvals WHERE requested_by = 'u-cash-a1';", 'c1')
    t.check('p6d7', 'R2-L4 a cashier cannot read another cashier\'s approval requests, but sees their own', "0 / t", (seen, own), seen == '0' and own == 't')
    # R2-H1: several manual overrides + an approval: the sale is checked once, complete
    cart = [{'product_id': 'prod-1', 'qty': 10, 'unit_price_mmk': 900}, {'product_id': 'prod-2', 'qty': 5, 'unit_price_mmk': 1800}]
    ref = 10 * 1000 + 5 * 2000
    b = t.j(t.disc_req_sql(ref, 2000, 'R2-H1 two overridden lines'), 'mgr')['approval']
    t.decide('admin', b['id'])
    s8 = t.with_headers({'x-orvix-discount-approval': b['id']}, lambda: t.sale('mgr', t.MG, cart, 'CASH', 18000)[0])
    t.check('p6d8', 'R2-H1 two manually overridden lines (10% below reference) with a matching approval commit (checked once, whole sale)',
            'total 18000, approval consumed', (s8['totalMmk'], t.q("SELECT consumed_sale_id FROM fin_approvals WHERE id=%s;" % L(b['id'])) == s8['id']),
            s8['totalMmk'] == 18000 and t.q("SELECT consumed_sale_id FROM fin_approvals WHERE id=%s;" % L(b['id'])) == s8['id'])
    # R2-M1: exactly the 5% the manager entered, rounded up by whole-MMK arithmetic (1050 at 5% = 53 MMK)
    s9, _ = t.sale('mgr', t.MG, [{'product_id': 'prod-1', 'qty': 1, 'unit_price_mmk': 1050}], 'CASH', 1050, disc=5)
    t.check('p6d9', 'R2-M1 a manager\'s own 5% cart discount on a 1,050 MMK cart (53 MMK after rounding) is within "up to and including 5%"',
            'total 997', s9['totalMmk'], s9['totalMmk'] == 997)
    t.refused('p6da', 'R2-M1 but two layers (3% line + 3% cart) still need approval', t.sale_sql(t.MG, t.sale_items(10, disc=3), 'CASH', 10000, 3, t.key()),
              'mgr', 'DISCOUNT_APPROVAL_REQUIRED')
    # R2-M2: the reference price applies the quantity tier exactly as complete_sale does
    t.q("INSERT INTO price_tiers (id, product_id, shop_id, min_qty, max_qty, price_mmk, is_active, created_by) VALUES ('tier-p6', 'prod-1', NULL, 10, NULL, 900, true, 'u-admin');")
    s10, _ = t.sale('mgr', t.MG, [{'product_id': 'prod-1', 'qty': 10, 'unit_price_mmk': 870}], 'CASH', 8700)
    t.q("UPDATE price_tiers SET is_active = false WHERE id = 'tier-p6';")
    t.check('p6db', 'R2-M2 a 900 MMK tier price overridden to 870 is a 3.3% reduction (not 13% against the untiered 1000): within a manager\'s 5%',
            'total 8700', s10['totalMmk'], s10['totalMmk'] == 8700)


def drawer_race(t):
    # R1-F2: two approvals of two DIFFERENT sales of one shift, each checked against the same 1000 expected cash
    c4 = t.q("SELECT id FROM shifts WHERE cashier_id='u-cash-a2' AND ended_at IS NULL;")
    t.q("SELECT public.fin_close_shift(%s, %d, 'p6 race setup', NULL, NULL, %s)::text;" % (L(c4), t.expected(c4), L(t.key())), 'c2')
    sh = t.open_shift('c2', 0)
    sa, _ = t.sale('c2', sh, t.sale_items(1), 'CASH', 1000)
    sb, _ = t.sale('c2', sh, t.sale_items(1), 'CASH', 1000)
    t.q("SELECT public.fin_record_cash_movement(%s, 'PAY_OUT', 1000, 'p6 race: drawer holds 1000', NULL, NULL, %s)::text;" % (L(sh), L(t.key())), 'mgr')
    ra = t.req('c2', sa['id'], [item('prod-1', 1, 1000, t.line_of(sa['id']), True)])
    rb = t.req('c2', sb['id'], [item('prod-1', 1, 1000, t.line_of(sb['id']), True)])
    pa = t.session('mgr', "BEGIN;\nSELECT 'R:' || (public.approve_refund_request(%s, %s) IS NOT NULL);\nSELECT pg_sleep(3);\nCOMMIT;" % (L(ra), L(t.key())), 'p6-race-a')
    t.wait(t.sleeping('p6-race-a'), pa)
    pb = t.session('admin', "SELECT 'R:' || (public.approve_refund_request(%s, %s) IS NOT NULL);" % (L(rb), L(t.key())), 'p6-race-b')
    rca, outa = t.finish(pa)
    rcb, outb = t.finish(pb)
    states = t.q("SELECT string_agg(status, ',' ORDER BY id) FROM refund_void_requests WHERE id IN (%s, %s);" % (L(ra), L(rb)))
    t.check('p6e0', 'R1-F2 two concurrent cash approvals against one 1000 MMK drawer: exactly one approved, the other refused FIN_DRAWER_INSUFFICIENT; drawer exactly 0',
            'one APPROVED, one REQUESTED, expected 0', (states, 'FIN_DRAWER_INSUFFICIENT' in outb, t.expected(sh)),
            sorted(states.split(',')) == ['APPROVED', 'REQUESTED'] and 'FIN_DRAWER_INSUFFICIENT' in outb and t.expected(sh) == 0)
    t.q("SELECT public.reject_refund_void_request(%s, 'p6 race cleanup', %s)::text;" % (L(rb), L(t.key())), 'mgr')


def drawer_closed(t):
    # R1-F2: the sale's shift is closed; the cash leaves a drawer open NOW in the shop; with none open the refund is refused
    sh = t.q("SELECT id FROM shifts WHERE cashier_id='u-cash-a2' AND ended_at IS NULL;")
    s, _ = t.sale('c2', sh, t.sale_items(1), 'CASH', 1000)
    t.q("SELECT public.fin_close_shift(%s, %d, 'p6 closed drawer', NULL, NULL, %s)::text;" % (L(sh), t.expected(sh), L(t.key())), 'c2')
    rid = t.req('c2', s['id'], [item('prod-1', 1, 1000, t.line_of(s['id']), True)])
    who_of = {v: k for k, v in fi.U.items()}
    for x in t.j("SELECT coalesce(json_agg(json_build_object('id',s.id,'auth',u.auth_id)),'[]')::text FROM shifts s JOIN users u ON u.id=s.cashier_id "
                 "WHERE s.ended_at IS NULL AND s.shop_id='shop-a';"):
        t.q("SELECT public.fin_close_shift(%s, %d, 'p6 close all drawers', NULL, NULL, %s)::text;" % (L(x['id']), t.expected(x['id']), L(t.key())), who_of[x['auth']])
    t.refused('p6f0', 'R1-F2 a cash refund of a closed shift\'s sale with NO drawer open in the shop is refused (never a negative drawer)',
              t.approve_sql(rid, t.key()), 'mgr', 'FIN_DRAWER_INSUFFICIENT')
    mg = t.open_shift('mgr', 5000)
    t.approve('mgr', rid)
    t.check('p6f1', 'R1-F2 with the approver\'s drawer open (5000) the refund is approved; accounting stays on the sale\'s shift (P-3)',
            'APPROVED; approver drawer unchanged 5000', (t.q("SELECT status FROM refund_void_requests WHERE id=%s;" % L(rid)), t.expected(mg)),
            t.q("SELECT status FROM refund_void_requests WHERE id=%s;" % L(rid)) == 'APPROVED' and t.expected(mg) == 5000)
    # follow-up review, F2: successive closed-shift refunds are counted against the drawer that pays them out
    rec = t.q("SELECT drawer_shift_id || ':' || cash_mmk FROM refund_cash_drawer WHERE request_id=%s;" % L(rid))
    t.check('p6f2', 'F2 the closed-shift refund recorded which open drawer paid it (the approver\'s, 1000)', '%s:1000' % mg, rec, rec == '%s:1000' % mg)
    c5 = t.open_shift('c2', 0)
    s5, _ = t.sale('c2', c5, t.sale_items(5), 'CASH', 5000)
    t.q("SELECT public.fin_close_shift(%s, %d, 'p6 F2 closed', NULL, NULL, %s)::text;" % (L(c5), t.expected(c5), L(t.key())), 'c2')
    l5 = t.line_of(s5['id'])
    r_a = t.req('c2', s5['id'], [item('prod-1', 4, 4000, l5, True)])
    t.approve('mgr', r_a)
    r_b = t.req('c2', s5['id'], [item('prod-1', 1, 1000, l5, True)])
    t.refused('p6f3', 'F2 the drawer (5000) already paid 1000 + 4000 for closed-shift sales: a further 1000 is refused although its own expected cash still shows 5000',
              t.approve_sql(r_b, t.key()), 'mgr', 'FIN_DRAWER_INSUFFICIENT')
    t.check('p6f4', 'F2 the drawer\'s recorded draws add up to 5000 (its available cash is 0)', '5000',
            t.q("SELECT sum(cash_mmk) FROM refund_cash_drawer WHERE drawer_shift_id=%s;" % L(mg)), t.q("SELECT sum(cash_mmk) FROM refund_cash_drawer WHERE drawer_shift_id=%s;" % L(mg)) == '5000')
