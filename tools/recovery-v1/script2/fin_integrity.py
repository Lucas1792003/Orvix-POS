"""Recovery Script 2 -- FINANCIAL INTEGRITY adversarial tests (PFIN-D split payments / cash movements, PFIN-E refund
lines, PFIN-B reports, PCOST-A cost) at the database level.

Run (private disposable cluster only; synthetic data only):
  python3 -I tools/recovery-v1/db/db-smoke.py --stage 86 --financial --script2-pre tools/recovery-v1/script2/fin_integrity.py
  (also with --with-087)

Isolation: everything runs in `fin_s2`, a CREATE DATABASE ... TEMPLATE copy of the harness database taken at the pre-hook
point (after the financial migrations and fin-completion-smoke, before Recovery V1). The harness's own database is not
written except for the result ledger (ctx['check']), so the later harness stages run on exactly what they expect.

Check kinds (prefix of the recorded name):
  fNN ...           an invariant that must hold; a FAIL is a demonstrated defect (the check asserts the CORRECT behaviour)
  fNN POLICY: ...   depends on an open owner decision (P-2 / P-3 / P-6 / P-8 or new): asserts CURRENT behaviour, informational
Evidence: <run>/fin-trace.log (every statement, actor and reply), <run>/fin-results.json, <run>/fin-sessions/*.log.
"""
import json
import subprocess
import time

DB = 'fin_s2'
U = {'admin': 'a0000000-0000-4000-8000-000000000001', 'mgr': 'a0000000-0000-4000-8000-000000000002',
     'c1': 'a0000000-0000-4000-8000-000000000003', 'c2': 'a0000000-0000-4000-8000-000000000004',
     'mgrb': 'a0000000-0000-4000-8000-000000000005', 'cb': 'a0000000-0000-4000-8000-000000000006',
     'xmgr': 'a0000000-0000-4000-8000-0000000000f2', 'xc': 'a0000000-0000-4000-8000-0000000000f1'}
PIPE, STDOUT = subprocess.PIPE, subprocess.STDOUT


class SqlError(Exception):
    pass


def J(o):
    return "$j$" + json.dumps(o, separators=(',', ':')) + "$j$::jsonb"


def L(s):
    return 'NULL' if s is None else "'" + str(s).replace("'", "''") + "'"


def errmsg(out):
    for line in out.splitlines():
        if 'ERROR:' in line:
            return line.split('ERROR:', 1)[1].strip()
    return out.strip()[-300:]


def pays_meta(pays):
    paid = sum(p.get('tenderedMmk', p['amountMmk']) for p in pays)
    return paid, ('CASH' if any(p['method'] == 'CASH' for p in pays) else 'OTHER')


def item(pid, qty, amt, line=None, restock=None, payouts=None):
    it = {'productId': pid, 'qtyUnits': qty, 'amountMmk': amt}
    if line is not None:
        ln = {'saleItemId': line, 'qtyUnits': qty, 'amountMmk': amt}
        if restock is not None:
            ln['restock'] = restock
        it['lines'] = [ln]
    if payouts is not None:
        it['payouts'] = [{'method': m, 'amountMmk': a} for m, a in payouts]
    return it


class F:
    def __init__(self, ctx):
        self.ctx = ctx
        self.run = ctx['run']
        self.env = dict(ctx['env'])
        a = list(ctx['dbargs'])
        a[a.index('-d') + 1] = DB
        self.args = a
        self.trace = open(self.run / 'fin-trace.log', 'w')
        (self.run / 'fin-sessions').mkdir(exist_ok=True)
        self.results = []
        self.k = 0

    # ------------------------------------------------------------ plumbing
    def key(self):
        self.k += 1
        return 'f5000000-0000-4000-8000-%012d' % self.k

    @staticmethod
    def prefix(who):
        return '' if who is None else "SELECT test.login('%s') AS zz \\gset\nSET ROLE authenticated;\n" % U[who]

    def exec(self, sql, who=None):
        script = self.prefix(who) + sql + '\n'
        p = subprocess.run(['psql', *self.args], input=script, text=True, env=self.env, stdout=PIPE, stderr=STDOUT)
        self.trace.write('--- [%s] rc=%s\n%s>>> %s\n' % (who or 'superuser', p.returncode, script, p.stdout))
        self.trace.flush()
        return p.returncode, p.stdout

    def q(self, sql, who=None):
        rc, out = self.exec(sql, who)
        if rc:
            raise SqlError(errmsg(out))
        return out.strip()

    def j(self, sql, who=None):
        return json.loads(self.q(sql, who))

    def err(self, sql, who=None):
        rc, out = self.exec(sql, who)
        return errmsg(out) if rc else None

    def check(self, cid, scenario, expected, actual, ok, kind='CHECK'):
        name = cid + ' ' + ('POLICY: ' if kind == 'POLICY' else '') + scenario
        self.results.append({'id': cid, 'kind': kind, 'scenario': scenario, 'expected': str(expected), 'actual': str(actual)[:600],
                             'result': 'POLICY' if kind == 'POLICY' and ok else ('PASS' if ok else 'FAIL')})
        self.trace.write('### %s %s | expected=%s | actual=%s\n' % ('PASS' if ok else 'FAIL', name, expected, str(actual)[:600]))
        self.ctx['check'](name, bool(ok), 'expected=%s actual=%s' % (expected, str(actual)[:200]))

    def guard(self, cid, scenario, fn):
        """run a scenario; an unexpected SQL error is recorded as a failure of that scenario (never silently skipped)"""
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            self.check(cid, scenario + ' [scenario aborted]', 'scenario runs', '%s: %s' % (type(e).__name__, e), False)

    STATE = ("SELECT json_build_object('sales',(SELECT count(*) FROM sales),'pay',(SELECT count(*) FROM sale_payments),"
             "'cm',(SELECT count(*) FROM cash_movements),'req',(SELECT count(*) FROM refund_void_requests),"
             "'appr',(SELECT count(*) FROM refund_void_requests WHERE status='APPROVED'),'rl',(SELECT count(*) FROM refund_lines),"
             "'rp',(SELECT count(*) FROM refund_payouts),'mv',(SELECT count(*) FROM inventory_movements),"
             "'inv',(SELECT sum(qty_base_units) FROM inventory),'idem',(SELECT count(*) FROM idempotency_keys),"
             "'closed',(SELECT count(*) FROM shifts WHERE ended_at IS NOT NULL),'audit',(SELECT count(*) FROM audit_logs))::text;")

    def state(self):
        return self.j(self.STATE)

    def refused(self, cid, scenario, sql, who, needle):
        """the statement must be refused with `needle` AND leave every financial table exactly as it was"""
        before = self.state()
        e = self.err(sql, who)
        after = self.state()
        diff = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
        self.check(cid, scenario, 'refused "%s", nothing written' % needle, (e or 'SUCCEEDED') + ('' if not diff else ' | CHANGED %s' % diff),
                   e is not None and needle in e and not diff)
        return e

    # ------------------------------------------------------------ business helpers
    def open_shift(self, who, opening):
        return self.q("SELECT public.open_shift('shop-a', %d, NULL, NULL, %s)->'shift'->>'id';" % (opening, L(self.key())), who)

    def sale_sql(self, shift, items, method='CASH', paid=None, disc=0, key=None, shop='shop-a'):
        return "SELECT public.complete_sale(%s, %s, %s, %s, %s, %s, NULL, %s)::text;" % (L(shop), L(shift), L(method), paid, disc, J(items), L(key))

    def sale(self, who, shift, items, method='CASH', paid=None, disc=0, key=None, shop='shop-a'):
        key = key or self.key()
        return self.j(self.sale_sql(shift, items, method, paid, disc, key, shop), who)['sale'], key

    def split_sql(self, shift, items, pays, disc=0, key=None, route='direct', shop='shop-a', paid=None, method=None, actor=None):
        p, m = pays_meta(pays)
        args = {'p_shop_id': shop, 'p_shift_id': shift, 'p_payment_method': method or m, 'p_paid_mmk': paid if paid is not None else p,
                'p_cart_discount_pct': disc, 'p_items': items}
        return "SELECT public.fin_complete_sale_split(%s, %s, %s, %s, %s)::text;" % (L(route), L(key), J(args), J(pays), L(actor))

    def split(self, who, shift, items, pays, disc=0, key=None):
        key = key or self.key()
        r = self.j(self.split_sql(shift, items, pays, disc, key), who)
        return r['sale'], key

    def line(self, sale_id, pid):
        return self.q("SELECT id FROM sale_items WHERE sale_id=%s AND product_id=%s;" % (L(sale_id), L(pid)))

    def req_sql(self, sale_id, items, key, typ='PARTIAL'):
        return "SELECT public.create_refund_void_request(%s, %s, 'fin adversarial test', %s, NULL, NULL, %s)->'request'->>'id';" % (
            L(sale_id), L(typ), 'NULL' if items is None else J(items), L(key))

    def req(self, who, sale_id, items, typ='PARTIAL'):
        return self.q(self.req_sql(sale_id, items, self.key(), typ), who)

    def approve_sql(self, rid, key):
        return "SELECT public.approve_refund_request(%s, %s)::text;" % (L(rid), L(key))

    def approve(self, who, rid, key=None):
        return self.j(self.approve_sql(rid, key or self.key()), who)

    def mv_sql(self, shift, kind, amount, reason='fin adversarial movement', rev=None, key=None):
        return "SELECT public.fin_record_cash_movement(%s, %s, %s, %s, %s, NULL, %s)::text;" % (
            L(shift), L(kind), 'NULL' if amount is None else amount, L(reason), L(rev), L(key))

    def mv(self, who, shift, kind, amount, rev=None):
        return self.j(self.mv_sql(shift, kind, amount, rev=rev, key=self.key()), who)['movement']

    def cash(self, shift):
        return self.j("SELECT public.fin_shift_cash(%s)::text;" % L(shift))

    def expected(self, shift):
        return int(self.cash(shift)['expectedCashMmk'])

    def indep(self, shift):
        """expected cash written independently from the specification (not from fin_shift_cash's text)"""
        s = L(shift)
        return int(self.q(f"""
WITH sh AS (SELECT opening_cash_mmk o FROM shifts WHERE id={s}),
cs AS (SELECT coalesce(sum(p.amount_mmk),0) v FROM sales x JOIN sale_payments p ON p.sale_id=x.id
        WHERE x.shift_id={s} AND x.status<>'VOID' AND p.method='CASH'),
po AS (SELECT coalesce(sum(rp.amount_mmk),0) v FROM refund_payouts rp JOIN sales x ON x.id=rp.sale_id WHERE x.shift_id={s} AND rp.method='CASH'),
lg_sale AS (SELECT x.id, sum((coalesce(i->>'amountMmk',i->>'amount_mmk'))::bigint) amt,
                   bool_or(EXISTS(SELECT 1 FROM sale_payments sp WHERE sp.sale_id=x.id AND sp.source='split')) is_split
              FROM refund_void_requests r JOIN sales x ON x.id=r.sale_id, jsonb_array_elements(r.items) i
             WHERE x.shift_id={s} AND x.payment_method='CASH' AND r.type='PARTIAL' AND r.status='APPROVED'
               AND NOT EXISTS (SELECT 1 FROM refund_payouts rp WHERE rp.request_id=r.id) GROUP BY x.id),
lg AS (SELECT coalesce(sum(CASE WHEN NOT is_split THEN amt ELSE least(amt, greatest(
          (SELECT coalesce(sum(amount_mmk),0) FROM sale_payments WHERE sale_id=l.id AND method='CASH')
        - (SELECT coalesce(sum(amount_mmk),0) FROM refund_payouts WHERE sale_id=l.id AND method='CASH'),0)) END),0) v FROM lg_sale l),
mv AS (SELECT coalesce(sum(amount_mmk*direction),0) v FROM cash_movements WHERE shift_id={s})
SELECT sh.o + cs.v - po.v - lg.v + mv.v FROM sh, cs, po, lg, mv;"""))

    def report(self, shop, basis='SALE_DATE'):
        return self.j("SELECT public.fin_report_summary(%s, (now() AT TIME ZONE 'Asia/Yangon')::date - 1, "
                      "(now() AT TIME ZONE 'Asia/Yangon')::date + 1, %s)->'totals';" % (L(shop), L(basis)), 'admin')

    def inv(self, pid, shop='shop-a'):
        return int(self.q("SELECT qty_base_units FROM inventory WHERE shop_id=%s AND product_id=%s;" % (L(shop), L(pid))))

    # ------------------------------------------------------------ concurrent sessions
    def session(self, who, body, app):
        env = dict(self.env, PGAPPNAME=app)
        p = subprocess.Popen(['psql', *self.args], stdin=PIPE, stdout=PIPE, stderr=STDOUT, text=True, env=env)
        p.stdin.write(self.prefix(who) + body + '\n')
        p.stdin.close()
        p.fin_app = app
        return p

    def finish(self, p):
        out = p.stdout.read()
        rc = p.wait()
        (self.run / 'fin-sessions' / (p.fin_app + '.log')).write_text('rc=%s\n%s' % (rc, out))
        self.trace.write('=== session %s rc=%s\n%s\n' % (p.fin_app, rc, out))
        return rc, out

    def wait(self, cond, proc=None, timeout=20.0):
        end = time.time() + timeout
        while time.time() < end:
            if self.q(cond) == 't':
                return True
            if proc is not None and proc.poll() is not None:
                return False
            time.sleep(0.05)
        return False

    @staticmethod
    def sleeping(app):
        return "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='%s' AND wait_event='PgSleep');" % app

    @staticmethod
    def blocked(app):
        return "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='%s' AND wait_event_type='Lock');" % app

    @staticmethod
    def results_of(out):
        return [l[2:] for l in out.splitlines() if l.startswith('R:')]


# ====================================================================================================================
def run(ctx):
    ctx['sql']("CREATE DATABASE %s TEMPLATE postgres;" % DB, 'fin-clone.log')
    t = F(ctx)
    t.today_ok = True
    sections = [setup, payments, cash_movements, refunds, close_x1, profit, cross_org, races, crashes, drawer_and_methods, invariants]
    for s in sections:
        t.guard('f--', 'section ' + s.__name__, lambda s=s: s(t))
    (t.run / 'fin-results.json').write_text(json.dumps(t.results, indent=1) + '\n')
    t.trace.close()


# -------------------------------------------------------------------------------------------------------------- setup
def setup(t):
    # shifts the earlier smokes left open in shop-a: close them with the authoritative figure, compared with the
    # independently written formula (history includes split sales, movements, payouts and legacy refunds)
    opened = t.j("SELECT coalesce(json_agg(json_build_object('id',id,'cashier',cashier_id)),'[]')::text FROM shifts WHERE ended_at IS NULL AND shop_id='shop-a';")
    for i, s in enumerate(opened):
        who = {'u-cash-a1': 'c1', 'u-cash-a2': 'c2'}[s['cashier']]
        e, ind = t.expected(s['id']), t.indep(s['id'])
        t.q("SELECT public.fin_close_shift(%s, %d, NULL, NULL, NULL, %s)::text;" % (L(s['id']), e, L(t.key())), who)
        stored = t.j("SELECT json_build_object('e',expected_cash_mmk,'v',variance_mmk)::text FROM shifts WHERE id=%s;" % L(s['id']))
        t.check('f00%s' % 'abcdef'[i], 'pre-existing shift %s (history from earlier smokes) closed: stored expected = fin_shift_cash = independent formula' % s['cashier'],
                ind, stored, stored['e'] == e == ind and stored['v'] == 0)
    t.X1 = t.open_shift('c1', 10000)
    t.X2 = t.open_shift('c2', 5000)
    t.exp = {t.X1: 10000, t.X2: 5000}
    t.check('f00z', 'fresh shifts X1 (cashier A1, opening 10000) and X2 (cashier A2, opening 5000)', '10000/5000',
            '%s/%s' % (t.expected(t.X1), t.expected(t.X2)), t.expected(t.X1) == 10000 and t.expected(t.X2) == 5000)


# ----------------------------------------------------------------------------------------------------------- payments
def payments(t):
    X1 = t.X1
    inv1 = t.inv('prod-1')
    s, k = t.sale('c1', X1, [{'product_id': 'prod-1', 'qty': 2}], 'CASH', 5000)
    rows = t.j("SELECT json_agg(json_build_object('m',method,'a',amount_mmk,'t',tendered_mmk,'s',source))::text FROM sale_payments WHERE sale_id=%s;" % L(s['id']))
    mvs = t.q("SELECT count(*)||':'||sum(qty_change) FROM inventory_movements WHERE reference_id=%s AND type='SALE_OUT';" % L(s['id']))
    t.exp[X1] += 2000
    t.check('f01', 'single CASH sale 2000 paid 5000: one CASH row amount 2000 tendered 5000, change 3000, stock -2 with one SALE_OUT',
            "[CASH 2000/5000 single], change 3000, inv-2, 1:-2", (rows, s['changeMmk'], t.inv('prod-1') - inv1, mvs),
            rows == [{'m': 'CASH', 'a': 2000, 't': 5000, 's': 'single'}] and s['changeMmk'] == 3000 and t.inv('prod-1') == inv1 - 2 and mvs == '1:-2')

    pays = [{'method': 'CASH', 'amountMmk': 2500, 'tenderedMmk': 3000}, {'method': 'CARD', 'amountMmk': 1500, 'reference': 'CARD-1'}]
    s2, k2 = t.split('c1', X1, [{'product_id': 'prod-2', 'qty': 2}], pays)
    t.S_split = s2
    t.K_split = k2
    rows = t.j("SELECT json_build_object('n',count(*),'sum',sum(amount_mmk),'ten',sum(tendered_mmk),'sha',count(DISTINCT payments_sha256),'key',min(op_key::text))::text FROM sale_payments WHERE sale_id=%s;" % L(s2['id']))
    t.exp[X1] += 2500
    t.check('f02', 'split CASH 2500 (tendered 3000) + CARD 1500 = 4000: 2 rows, applied = total, paid 4500, change 500 from cash only, one sha, op_key recorded',
            'n2 sum4000 ten4500 change500 method CASH', (rows, s2['paidMmk'], s2['changeMmk'], s2['paymentMethod']),
            rows['n'] == 2 and rows['sum'] == 4000 == s2['totalMmk'] and rows['ten'] == 4500 == s2['paidMmk'] and s2['changeMmk'] == 500
            and rows['sha'] == 1 and rows['key'] == k2 and s2['paymentMethod'] == 'CASH')

    s3, _ = t.split('c1', X1, [{'product_id': 'prod-3', 'qty': 1}],
                    [{'method': 'MOBILE_WALLET', 'amountMmk': 1000}, {'method': 'CASH', 'amountMmk': 1000}, {'method': 'BANK_TRANSFER', 'amountMmk': 1000, 'reference': 'TRX-9'}])
    t.exp[X1] += 1000
    t.check('f03', 'mixed 3-method split (wallet/cash/bank 1000 each): 3 rows ordered canonically, change 0, cash part 1000 only in drawer',
            'cash +1000', t.expected(X1), t.expected(X1) == t.exp[X1] and s3['changeMmk'] == 0)

    s4, _ = t.split('c1', X1, [{'product_id': 'prod-3', 'qty': 1}], [{'method': 'CARD', 'amountMmk': 2000}, {'method': 'OTHER', 'amountMmk': 1000}])
    t.check('f04', 'non-cash split (CARD 2000 + OTHER 1000): sale recorded OTHER, drawer unchanged', 'OTHER, cash unchanged',
            (s4['paymentMethod'], t.expected(X1)), s4['paymentMethod'] == 'OTHER' and t.expected(X1) == t.exp[X1])

    items2 = [{'product_id': 'prod-1', 'qty': 2}]
    t.refused('f05', 'underpayment: applied 1000 of 2000 while tendered covers the total (cash 500 tendered 1500 + card 500): FIN_PAYMENTS_TOTAL, nothing written',
              t.split_sql(X1, items2, [{'method': 'CASH', 'amountMmk': 500, 'tenderedMmk': 1500}, {'method': 'CARD', 'amountMmk': 500}], key=t.key()), 'c1', 'FIN_PAYMENTS_TOTAL')
    t.refused('f06', 'underpayment: tendered below the total: refused by complete_sale, nothing written',
              t.split_sql(X1, items2, [{'method': 'CASH', 'amountMmk': 500}, {'method': 'CARD', 'amountMmk': 500}], key=t.key()), 'c1', 'less than the sale total')
    t.refused('f07', 'overpayment by applied amounts (cash 1500 + card 1000 for 2000): FIN_PAYMENTS_TOTAL, nothing written',
              t.split_sql(X1, items2, [{'method': 'CASH', 'amountMmk': 1500}, {'method': 'CARD', 'amountMmk': 1000}], key=t.key()), 'c1', 'FIN_PAYMENTS_TOTAL')
    t.refused('f08', 'change on a non-cash split payment (CARD 2000 tendered 2500) refused, nothing written',
              t.split_sql(X1, items2, [{'method': 'CARD', 'amountMmk': 2000, 'tenderedMmk': 2500}], key=t.key()), 'c1', 'FIN_PAYMENTS_INVALID')
    t.refused('f09', 'negative / zero split amount refused', t.split_sql(X1, items2, [{'method': 'CASH', 'amountMmk': 2500}, {'method': 'CARD', 'amountMmk': -500}], key=t.key()),
              'c1', 'FIN_PAYMENTS_INVALID')

    # legacy single OTHER payment with paid > total (pinned complete_sale): change recorded on a non-cash payment
    s8, _ = t.sale('c1', X1, [{'product_id': 'prod-1', 'qty': 1}], 'OTHER', 5000)
    row = t.j("SELECT json_build_object('m',method,'a',amount_mmk,'t',tendered_mmk)::text FROM sale_payments WHERE sale_id=%s;" % L(s8['id']))
    t.check('f10', 'single OTHER sale 1000 with paid 5000 (pinned complete_sale) is accepted with change 4000 on a NON-CASH payment; drawer figure ignores the 4000 change '
            '(owner decision: refuse change on non-cash single payments, or count it as a cash outflow)', 'accepted, change 4000, drawer unchanged',
            (s8['changeMmk'], row, t.expected(X1)), s8['changeMmk'] == 4000 and row == {'m': 'OTHER', 'a': 1000, 't': 5000} and t.expected(X1) == t.exp[X1], 'POLICY')

    # duplicate submission / key reuse
    before = t.state()
    r = t.j(t.split_sql(X1, [{'product_id': 'prod-2', 'qty': 2}], list(reversed(pays)), key=k2), 'c1')
    after = t.state()
    t.check('f11', 'duplicate split submission with the same key (payments in another order) replays the same sale; no new sale/payment/movement/key rows',
            'same id, state unchanged', (r['sale']['id'] == s2['id'], {k: (before[k], after[k]) for k in before if before[k] != after[k]}),
            r['sale']['id'] == s2['id'] and before == after)
    t.refused('f12', 'retried payment with the same key but a different split (cash 2000 tendered 2500 + card 2000) is refused, nothing written',
              t.split_sql(X1, [{'product_id': 'prod-2', 'qty': 2}], [{'method': 'CASH', 'amountMmk': 2000, 'tenderedMmk': 2500}, {'method': 'CARD', 'amountMmk': 2000}], key=k2),
              'c1', 'FIN_PAYMENTS_MISMATCH')
    t.refused('f13', 'same key, same split, different cart (qty 3): refused, nothing written',
              t.split_sql(X1, [{'product_id': 'prod-2', 'qty': 3}], [{'method': 'CASH', 'amountMmk': 4500, 'tenderedMmk': 5000}, {'method': 'CARD', 'amountMmk': 1500}], key=k2),
              'c1', 'MISMATCH')
    before = t.state()
    r = t.j(t.sale_sql(X1, [{'product_id': 'prod-2', 'qty': 2}], 'CASH', 4500, 0, k2), 'c1')
    after = t.state()
    t.check('f14', 'the split key re-sent through plain complete_sale with identical sale arguments replays the split sale (no single-payment duplicate)',
            'same id, state unchanged', r['sale']['id'] == s2['id'] and before == after, r['sale']['id'] == s2['id'] and before == after)
    t.refused('f15', 'key reuse across RPCs: a sale key used for a cash movement is refused, nothing written',
              t.mv_sql(X1, 'PAY_IN', 100, key=k2), 'c1', 'IDEMPOTENCY_MISMATCH')
    t.refused('f16', 'key reuse across RPCs: a sale key used for fin_close_shift is refused (shift stays open)',
              "SELECT public.fin_close_shift(%s, 0, 'x', NULL, NULL, %s);" % (L(X1), L(k2)), 'c1', 'IDEMPOTENCY_MISMATCH')

    # 086 op_execute route
    k13 = t.key()
    items13 = [{'product_id': 'prod-1', 'qty': 2}]
    p13 = [{'method': 'CASH', 'amountMmk': 1000}, {'method': 'CARD', 'amountMmk': 1000}]
    r1 = t.j(t.split_sql(X1, items13, p13, key=k13, route='op_execute'), 'c1')
    before = t.state()
    r2 = t.j(t.split_sql(X1, items13, p13, key=k13, route='op_execute'), 'c1')
    after = t.state()
    t.exp[X1] += 1000
    sid = r1['response']['sale']['id']
    t.check('f17', 'split through 086 op_execute: committed; replay through op_execute answers committed/replayed with the same sale, no new rows',
            'committed, replayed same id', (r1.get('outcome'), r2.get('outcome'), r2.get('replayed'), (r2.get('response') or {}).get('sale', {}).get('id') == sid, before == after),
            r1.get('outcome') == 'committed' and r2.get('replayed') is True and r2['response']['sale']['id'] == sid and before == after
            and t.q("SELECT count(*) FROM sale_payments WHERE sale_id=%s;" % L(sid)) == '2')
    t.refused('f18', 'op_execute route: same key with a different split is refused before anything runs',
              t.split_sql(X1, items13, [{'method': 'CASH', 'amountMmk': 500}, {'method': 'CARD', 'amountMmk': 1500}], key=k13, route='op_execute'), 'c1', 'FIN_PAYMENTS_MISMATCH')
    over = [{'method': 'CASH', 'amountMmk': 1500, 'tenderedMmk': 1500}, {'method': 'CARD', 'amountMmk': 1000}]
    t.refused('f19', 'op_execute route, no actor id: an over-allocated split (2500 applied for 2000) is refused with FIN_PAYMENTS_TOTAL and nothing (not even a ledger row) is written',
              t.split_sql(X1, items13, over, key=t.key(), route='op_execute', paid=2500), 'c1', 'FIN_PAYMENTS_TOTAL')
    k20 = t.key()
    before = t.state()
    rc, out = t.exec(t.split_sql(X1, items13, over, key=k20, route='op_execute', paid=2500, actor='u-cash-a1'), 'c1')
    after = t.state()
    led = t.q("SELECT coalesce(min(state),'none') FROM idempotency_keys WHERE key=%s;" % L(k20))
    diff = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
    t.check('f20', 'op_execute route WITH actor id: the over-allocated split is refused (op_not_recorded), no sale/payment/stock/movement row and no ledger row '
            '(the till may retry the SAME key with a corrected split)', 'refused, nothing written, ledger none',
            (errmsg(out)[:120], led, diff), rc != 0 and 'FIN_PAYMENTS_TOTAL' in out and diff == {} and led == 'none')
    after_fix = t.j(t.split_sql(X1, items13, [{'method': 'CASH', 'amountMmk': 500, 'tenderedMmk': 1000}, {'method': 'CARD', 'amountMmk': 1500}],
                                key=k20, route='op_execute', paid=2500, actor='u-cash-a1'), 'c1')
    t.exp[X1] += 500
    t.check('f20b', 'the same op_execute key retried with a corrected split (cash 500 tendered 1000 + card 1500, same paid 2500) commits once, change 500 from cash',
            'committed, change 500', (after_fix.get('outcome'), (after_fix.get('response') or {}).get('sale', {}).get('changeMmk')),
            after_fix.get('outcome') == 'committed' and after_fix['response']['sale']['changeMmk'] == 500)
    t.check('f21', 'drawer after the payment scenarios = opening + cash parts only (f01 2000, f02 2500, f03 1000, f17 1000, f20b 500)', t.exp[X1], t.expected(X1),
            t.expected(X1) == t.exp[X1] == t.indep(X1))


# ----------------------------------------------------------------------------------------------------- cash movements
def cash_movements(t):
    X1, X2 = t.X1, t.X2
    t.mv('c1', X1, 'PAY_IN', 2000)
    t.exp[X1] += 2000
    t.check('f22', 'cashier PAY_IN 2000 on own shift recorded; drawer +2000', t.exp[X1], t.expected(X1), t.expected(X1) == t.exp[X1])
    t.refused('f23', 'cashier PAY_OUT refused (P-8 default: manager only), nothing written', t.mv_sql(X1, 'PAY_OUT', 100, key=t.key()), 'c1', 'Only a manager')
    t.refused('f24', 'cashier A2 PAY_IN on cashier A1\'s shift refused', t.mv_sql(X1, 'PAY_IN', 100, key=t.key()), 'c2', 'not permitted')
    t.refused('f25', 'manager of another shop (shop-b) PAY_OUT on a shop-a shift refused', t.mv_sql(X1, 'PAY_OUT', 100, key=t.key()), 'mgrb', 'Only a manager')
    t.refused('f26', 'cashier of another shop PAY_IN on a shop-a shift refused', t.mv_sql(X1, 'PAY_IN', 100, key=t.key()), 'cb', 'not permitted')
    t.refused('f27', 'manager of another organization PAY_IN on a shop-a shift: not found', t.mv_sql(X1, 'PAY_IN', 100, key=t.key()), 'xmgr', 'not found')
    closed = t.q("SELECT id FROM shifts WHERE ended_at IS NOT NULL AND shop_id='shop-a' ORDER BY ended_at DESC LIMIT 1;")
    t.refused('f28', 'movement on a closed shift refused', t.mv_sql(closed, 'PAY_IN', 100, key=t.key()), 'mgr', 'already closed')
    t.refused('f29', 'zero amount refused', t.mv_sql(X1, 'PAY_IN', 0, key=t.key()), 'c1', 'greater than zero')
    t.refused('f30', 'negative amount refused', t.mv_sql(X1, 'PAY_OUT', -500, key=t.key()), 'mgr', 'greater than zero')
    t.refused('f31', 'reason shorter than 3 characters refused', t.mv_sql(X1, 'PAY_IN', 100, reason='ok', key=t.key()), 'c1', 'reason of 3 to 300')
    out = t.mv('mgr', X1, 'PAY_OUT', 3000)
    t.exp[X1] -= 3000
    t.check('f32', 'manager PAY_OUT 3000 recorded with approver = manager; drawer -3000', t.exp[X1], (t.expected(X1), out['approvedBy']),
            t.expected(X1) == t.exp[X1] and out['approvedBy'] == 'u-mgr-a')
    e = t.expected(X1)
    t.refused('f33', 'cash-out of drawer + 1 refused (DEPOSIT_OUT %d with %d expected)' % (e + 1, e), t.mv_sql(X1, 'DEPOSIT_OUT', e + 1, key=t.key()), 'mgr', 'cannot be taken out')
    t.refused('f34', 'cashier cannot reverse a movement (manager only)', t.mv_sql(X1, 'REVERSAL', None, rev=out['id'], key=t.key()), 'c1', 'Only a manager')
    t.refused('f35', 'partial reversal (amount differs) refused', t.mv_sql(X1, 'REVERSAL', 1000, rev=out['id'], key=t.key()), 'mgr', 'full amount')
    rv = t.mv('mgr', X1, 'REVERSAL', None, rev=out['id'])
    t.exp[X1] += 3000
    t.check('f36', 'reversal of PAY_OUT once: new row, opposite direction, full amount; drawer back +3000', (1, 3000, t.exp[X1]),
            (rv['direction'], rv['amountMmk'], t.expected(X1)), rv['direction'] == 1 and rv['amountMmk'] == 3000 and t.expected(X1) == t.exp[X1])
    t.refused('f37', 'second reversal of the same movement refused', t.mv_sql(X1, 'REVERSAL', None, rev=out['id'], key=t.key()), 'mgr', 'already reversed')
    t.refused('f38', 'reversal of a reversal refused', t.mv_sql(X1, 'REVERSAL', None, rev=rv['id'], key=t.key()), 'mgr', 'cannot itself be reversed')
    # X2: reversal of a cash-IN that the drawer no longer holds
    pin = t.mv('c2', X2, 'PAY_IN', 10000)
    t.exp[X2] += 10000
    t.mv('mgr', X2, 'DEPOSIT_OUT', 14000)
    t.exp[X2] -= 14000
    t.refused('f39', 'reversal of a movement of another shift refused', t.mv_sql(X1, 'REVERSAL', None, rev=pin['id'], key=t.key()), 'mgr', 'not part of this shift')
    t.refused('f40', 'reversal of PAY_IN 10000 when the drawer holds 1000 is a cash-out beyond the drawer: refused',
              t.mv_sql(X2, 'REVERSAL', None, rev=pin['id'], key=t.key()), 'mgr', 'cannot be taken out')
    km = t.key()
    a = t.j(t.mv_sql(X2, 'PAY_IN', 700, key=km), 'c2')
    before = t.state()
    b = t.j(t.mv_sql(X2, 'PAY_IN', 700, key=km), 'c2')
    after = t.state()
    t.exp[X2] += 700
    t.check('f41', 'duplicate movement (same key) replays: one row, same reply', 'same reply, no change', (a == b, before == after), a == b and before == after)
    t.refused('f42', 'same movement key with another amount refused', t.mv_sql(X2, 'PAY_IN', 701, key=km), 'c2', 'IDEMPOTENCY_MISMATCH')
    t.check('f43', 'X2 drawer: 5000 + 10000 - 14000 + 700', t.exp[X2], t.expected(X2), t.expected(X2) == t.exp[X2] == t.indep(X2))
    summ = t.j("SELECT public.fin_payment_summary('shop-a', (now() AT TIME ZONE 'Asia/Yangon')::date - 1, (now() AT TIME ZONE 'Asia/Yangon')::date + 1)::text;", 'admin')
    ind = t.j("""SELECT coalesce(json_object_agg(k, v),'{}')::text FROM (SELECT coalesce(o.kind, m.kind) k, sum(m.amount_mmk*m.direction) v FROM cash_movements m
                 LEFT JOIN cash_movements o ON o.id=m.reverses_id WHERE m.shop_id='shop-a' AND m.created_at >= now() - interval '2 days' GROUP BY 1) x;""")
    pays = t.j("""SELECT coalesce(json_object_agg(method, v),'{}')::text FROM (SELECT p.method, sum(p.amount_mmk) v FROM sale_payments p JOIN sales s ON s.id=p.sale_id
                  WHERE s.shop_id='shop-a' AND s.status<>'VOID' AND s.created_at >= now() - interval '2 days' GROUP BY 1) x;""")
    t.check('f44', 'fin_payment_summary per method and per movement kind (reversal netted under its kind) = independent sums over the rows',
            (pays, ind), (summ['payments'], summ['cashMovements']),
            {k: int(v) for k, v in summ['payments'].items()} == pays and {k: int(v) for k, v in summ['cashMovements'].items()} == ind)


# ------------------------------------------------------------------------------------------------------------ refunds
def refunds(t):
    X1 = t.X1
    # R1: prod-1 x3 + prod-2 x2, 10% cart discount -> total 6300; net lines 2700 / 3600; CASH 3300 (tendered 4000) + CARD 3000
    r1, _ = t.split('c1', X1, [{'product_id': 'prod-1', 'qty': 3}, {'product_id': 'prod-2', 'qty': 2}],
                    [{'method': 'CASH', 'amountMmk': 3300, 'tenderedMmk': 4000}, {'method': 'CARD', 'amountMmk': 3000}], disc=10)
    t.exp[X1] += 3300
    S = r1['id']
    l1, l2 = t.line(S, 'prod-1'), t.line(S, 'prod-2')
    net = t.j("SELECT json_object_agg(product_id, net_mmk)::text FROM fin_sale_line_net(ARRAY[%s]);" % L(S))
    t.check('f45', 'cart-discounted split sale: total 6300, change 700, net per line 2700 / 3600 (sum = total)', {'prod-1': 2700, 'prod-2': 3600},
            (r1['totalMmk'], r1['changeMmk'], net), r1['totalMmk'] == 6300 and r1['changeMmk'] == 700 and net == {'prod-1': 2700, 'prod-2': 3600})
    i1, i2 = t.inv('prod-1'), t.inv('prod-2')
    ra = t.req('c1', S, [item('prod-1', 1, 900, l1, True, [('CASH', 900)])])
    t.approve('mgr', ra)
    t.exp[X1] -= 900
    rl = t.j("SELECT json_build_object('n',count(*),'q',sum(qty_units),'a',sum(amount_mmk),'c',min(cost_mmk),'r',bool_and(restocked))::text FROM refund_lines WHERE request_id=%s;" % L(ra))
    t.check('f46', 'line refund 1 x prod-1 = 900 (net), restock, CASH payout: refund line with cost 600, stock +1 (RETURN_IN), drawer -900',
            {'n': 1, 'q': 1, 'a': 900, 'c': 600, 'r': True}, (rl, t.inv('prod-1') - i1, t.expected(X1)),
            rl == {'n': 1, 'q': 1, 'a': 900, 'c': 600, 'r': True} and t.inv('prod-1') == i1 + 1 and t.expected(X1) == t.exp[X1])
    rb = t.req('c1', S, [item('prod-1', 1, 900, l1, True, [('CARD', 900)])])
    t.approve('mgr', rb)
    t.check('f47', 'second partial refund of the same sale/line (CARD payout): accepted, drawer unchanged', t.exp[X1], t.expected(X1), t.expected(X1) == t.exp[X1])
    t.refused('f48', 'over-refund by quantity on a line (2 more of the 1 left) refused at request time, nothing written',
              t.req_sql(S, [item('prod-1', 2, 1800, l1, True, [('CASH', 1800)])], t.key()), 'c1', 'exceeds what was sold on this line')
    t.refused('f49', 'over-refund by net amount on a line (1000 for a unit whose remaining net is 900) refused',
              t.req_sql(S, [item('prod-1', 1, 1000, l1, True, [('CASH', 1000)])], t.key()), 'c1', 'after discounts')
    t.refused('f50', 'payout by CARD beyond what CARD paid (prior 900 + 3600 > 3000) refused',
              t.req_sql(S, [item('prod-2', 2, 3600, l2, True, [('CARD', 3600)])], t.key()), 'c1', 'exceeds what the customer paid that way')
    t.refused('f51', 'payout by a method the sale was never paid with (MOBILE_WALLET) refused',
              t.req_sql(S, [item('prod-2', 1, 1800, l2, True, [('MOBILE_WALLET', 1800)])], t.key()), 'c1', 'exceeds what the customer paid that way')
    t.refused('f52', 'payouts that do not add up to the item amount refused', t.req_sql(S, [item('prod-2', 1, 1800, l2, True, [('CASH', 1000)])], t.key()), 'c1', 'do not add up')
    t.refused('f53', 'payouts named for one item but not another refused',
              t.req_sql(S, [item('prod-1', 1, 900, l1, True, [('CASH', 900)]), item('prod-2', 1, 1800, l2, True)], t.key()), 'c1', 'every item must name it')
    t.refused('f54', 'a refund line of another product refused', t.req_sql(S, [item('prod-2', 1, 900, l1, True)], t.key()), 'c1', 'another product')
    dup = {'productId': 'prod-2', 'qtyUnits': 2, 'amountMmk': 1800, 'lines': [{'saleItemId': l2, 'qtyUnits': 1, 'amountMmk': 900}, {'saleItemId': l2, 'qtyUnits': 1, 'amountMmk': 900}]}
    t.refused('f55', 'the same sale line twice in one request refused', t.req_sql(S, [dup], t.key()), 'c1', 'more than once')
    t.refused('f56', 'fractional refund amount refused', t.req_sql(S, [{'productId': 'prod-2', 'qtyUnits': 1, 'amountMmk': 899.5,
              'lines': [{'saleItemId': l2, 'qtyUnits': 1, 'amountMmk': 899.5}]}], t.key()), 'c1', 'whole amount')
    # multi-item refund, multiple payouts per item aggregated per method; prod-2 not restocked
    i1, i2 = t.inv('prod-1'), t.inv('prod-2')
    MVQ = "SELECT coalesce(json_object_agg(type, s),'{}')::text FROM (SELECT type, sum(qty_change) s FROM inventory_movements WHERE product_id='prod-2' AND shop_id='shop-a' GROUP BY 1) x;"
    mv0 = t.j(MVQ)
    rc_ = t.req('c1', S, [item('prod-1', 1, 900, l1, True, [('CASH', 400), ('CARD', 500)]), item('prod-2', 1, 1800, l2, False, [('CASH', 1000), ('CARD', 800)])])
    t.approve('mgr', rc_)
    t.exp[X1] -= 1400
    po = t.j("SELECT json_object_agg(method, amount_mmk)::text FROM refund_payouts WHERE request_id=%s;" % L(rc_))
    mv1 = t.j(MVQ)
    dmv = {k: mv1.get(k, 0) - mv0.get(k, 0) for k in set(mv0) | set(mv1) if mv1.get(k, 0) != mv0.get(k, 0)}
    t.check('f57', 'multi-item refund with several payouts per item: one payout row per method, summed (CASH 400+1000, CARD 500+800)', {'CASH': 1400, 'CARD': 1300}, po,
            po == {'CASH': 1400, 'CARD': 1300})
    t.check('f58', 'no-restock line: RETURN_IN +1 then RETURN_NO_RESTOCK -1 (net 0) for prod-2; prod-1 restocked +1; drawer -1400',
            "{'RETURN_IN': 1, 'RETURN_NO_RESTOCK': -1}, prod-2 +0, prod-1 +1", (dmv, t.inv('prod-2') - i2, t.inv('prod-1') - i1, t.expected(X1)),
            dmv == {'RETURN_IN': 1, 'RETURN_NO_RESTOCK': -1} and t.inv('prod-2') == i2 and t.inv('prod-1') == i1 + 1 and t.expected(X1) == t.exp[X1])
    t.refused('f59', 'remaining prod-2 (1 unit, net 1800) all in CASH: CASH prior 2300 + 1800 > 3300 refused', t.req_sql(S, [item('prod-2', 1, 1800, l2, True, [('CASH', 1800)])], t.key()),
              'c1', 'exceeds what the customer paid that way')
    rd = t.req('c1', S, [item('prod-2', 1, 1800, l2, True, [('CASH', 1000), ('CARD', 800)])])
    t.approve('mgr', rd)
    t.exp[X1] -= 1000
    tot = t.j("SELECT json_build_object('rl',(SELECT sum(amount_mmk) FROM refund_lines WHERE sale_id=%s),'rp',(SELECT sum(amount_mmk) FROM refund_payouts WHERE sale_id=%s),"
              "'cash',(SELECT sum(amount_mmk) FROM refund_payouts WHERE sale_id=%s AND method='CASH'),'card',(SELECT sum(amount_mmk) FROM refund_payouts WHERE sale_id=%s AND method='CARD'))::text;" % (L(S), L(S), L(S), L(S)))
    t.check('f60', 'sale fully refunded exactly to the MMK: lines 6300 = payouts 6300 = total; CASH 3300 = cash applied (never the 700 change); CARD 3000',
            {'rl': 6300, 'rp': 6300, 'cash': 3300, 'card': 3000}, tot, tot == {'rl': 6300, 'rp': 6300, 'cash': 3300, 'card': 3000})
    rx = t.req('c1', S, [item('prod-1', 1, 0)])   # a legacy item carries no lines: only the pinned approval bounds it
    t.refused('f61', 'after a full refund, a legacy item (no lines, amount 0) is still refused at approval by the pinned per-product quantity check',
              t.approve_sql(rx, t.key()), 'mgr', 'exceeds original sale quantity')
    t.q("SELECT public.reject_refund_void_request(%s, 'cleanup', %s)::text;" % (L(rx), L(t.key())), 'mgr')
    # legacy (no lines) refund mixed with line refunds: R3 prod-1 x3, single CASH 3000
    r3, _ = t.sale('c1', X1, [{'product_id': 'prod-1', 'qty': 3}], 'CASH', 3000)
    t.exp[X1] += 3000
    S3 = r3['id']
    l3 = t.line(S3, 'prod-1')
    rl = t.req('c1', S3, [item('prod-1', 1, 1000)])
    t.approve('mgr', rl)
    t.exp[X1] -= 1000
    rl2 = t.req('c1', S3, [item('prod-1', 2, 2000, l3, True)])
    t.approve('mgr', rl2)
    t.exp[X1] -= 2000
    st = t.j("SELECT public.fin_refund_lines_state(%s)::text;" % L(S3), 'c1')
    t.check('f62', 'legacy refund (1 unit, no lines) then line refund (2 units, no payouts): the legacy unit counts against the line; '
            'remaining 0 / 0 MMK; legacy row unattributed with NULL cost; drawer -3000 (legacy rule on a single CASH sale)',
            'remaining 0, 1 unattributed, cash ok', (st['lines'][0]['remainingQtyUnits'], st['lines'][0]['remainingMmk'], st['unattributedRefundedMmk'], t.expected(X1)),
            st['lines'][0]['remainingQtyUnits'] == 0 and st['lines'][0]['remainingMmk'] == 0 and st['unattributedRefundedMmk'] == 1000 and t.expected(X1) == t.exp[X1])
    t.refused('f63', 'a further line refund after legacy + line refunds exhausted the line is refused', t.req_sql(S3, [item('prod-1', 1, 1000, l3, True)], t.key()), 'c1',
              'exceeds what was sold on this line')
    # overall cap: legacy refund above net on a cart-discounted non-cash split sale, then a line refund
    r4, _ = t.split('c1', X1, [{'product_id': 'prod-1', 'qty': 1}, {'product_id': 'prod-2', 'qty': 1}],
                    [{'method': 'CARD', 'amountMmk': 1800}, {'method': 'BANK_TRANSFER', 'amountMmk': 900}], disc=10)
    S4 = r4['id']
    rr = t.req('c1', S4, [item('prod-2', 1, 2000)])
    t.approve('mgr', rr)
    over = t.j("SELECT json_build_object('refunded',(SELECT sum(amount_mmk) FROM refund_lines WHERE sale_id=%s),'net',(SELECT net_mmk FROM fin_sale_line_net(ARRAY[%s]) WHERE product_id='prod-2'))::text;" % (L(S4), L(S4)))
    t.check('f64', 'legacy refund item (no lines) of 2000 on a line whose net after the 10% cart discount is 1800 is APPROVED: only the pinned '
            'pre-discount line-total cap applies to legacy items (PFIN-C held; P-2 / P-6)', 'approved 2000 > net 1800', over,
            over['refunded'] == 2000 and over['net'] == 1800, 'POLICY')
    l4 = t.line(S4, 'prod-1')
    t.refused('f65', 'overall cap: legacy 2000 already refunded + line refund 900 by CARD > 2700 paid refused ("would exceed what the customer paid")',
              t.req_sql(S4, [item('prod-1', 1, 900, l4, True, [('CARD', 900)])], t.key()), 'c1', 'exceed what the customer paid for this sale')
    t.check('f66', 'drawer after all refunds = hand-computed = independent formula', t.exp[X1], (t.expected(X1), t.indep(X1)),
            t.expected(X1) == t.exp[X1] == t.indep(X1))


# ------------------------------------------------------------------------------------------------------- close X1 / P-3
def close_x1(t):
    X1 = t.X1
    exp = t.exp[X1]
    # independent arithmetic of this shift: opening 10000 + cash 2000+2500+1000+1000+3300+3000 - refunds 900+1400+1000+1000+2000 + 2000 - 3000 + 3000
    hand = 10000 + (2000 + 2500 + 1000 + 1000 + 500 + 3300 + 3000) - (900 + 1400 + 1000 + 1000 + 2000) + (2000 - 3000 + 3000)
    t.refused('f67', 'legacy close_shift (with a variance reason, so it reaches the update) on a shift with split payments / movements refused (no wrong figure stored)',
              "SELECT public.close_shift(%s, %d, 'legacy till count', NULL, NULL, %s);" % (L(X1), exp, L(t.key())), 'c1', 'FIN_CLOSE_SHIFT_UPGRADE_REQUIRED')
    t.refused('f67b', 'cashier A2 cannot fin_close_shift cashier A1\'s shift', "SELECT public.fin_close_shift(%s, %d, NULL, NULL, NULL, %s);" % (L(X1), exp, L(t.key())),
              'c2', 'not permitted')
    t.refused('f68', 'fin_close_shift with closing != expected and no variance reason refused', "SELECT public.fin_close_shift(%s, %d, NULL, NULL, NULL, %s);" % (L(X1), exp - 50, L(t.key())),
              'c1', 'Variance reason is required')
    t.q("SELECT public.fin_close_shift(%s, %d, 'counted 50 short', NULL, NULL, %s)::text;" % (L(X1), exp - 50, L(t.key())), 'c1')
    st = t.j("SELECT json_build_object('e',expected_cash_mmk,'c',closing_cash_mmk,'v',variance_mmk,'r',variance_reason)::text FROM shifts WHERE id=%s;" % L(X1))
    t.check('f69', 'fin_close_shift X1: stored expected = opening + cash parts of non-void sales - cash refunds/payouts + in - out (hand %d), variance -50 with reason' % hand,
            hand, (st, t.indep(X1), t.expected(X1)), st['e'] == hand == exp == t.indep(X1) == t.expected(X1) and st['v'] == -50 and st['c'] == hand - 50)
    # P-3: a refund of a closed shift's sale is still attributed to that closed shift
    S2 = t.S_split['id']
    r = t.req('c2', S2, [item('prod-2', 1, 2000, t.line(S2, 'prod-2'), True, [('CASH', 2000)])])
    t.approve('mgr', r)
    t.check('f70', 'a CASH refund approved AFTER its sale\'s shift closed is attributed to the closed shift: fin_shift_cash(X1) moves by -2000 while '
            'the stored close figure stays (P-3 attribution, owner decision)', 'stored %d, recomputed %d' % (hand, hand - 2000),
            (st['e'], t.expected(X1)), t.expected(X1) == hand - 2000 and int(t.q("SELECT expected_cash_mmk FROM shifts WHERE id=%s;" % L(X1))) == hand, 'POLICY')


# ------------------------------------------------------------------------------------------------------------- profit
def profit(t):
    X2 = t.X2
    b = t.report('shop-a')
    s, _ = t.sale('c2', X2, [{'product_id': 'prod-2', 'qty': 1}], 'CASH', 2000)
    t.exp[X2] += 2000
    a = t.report('shop-a')
    t.check('f71', 'sale of 1 x prod-2 (2000, cost 1200): report gross +2000, COGS +1200', (2000, 1200),
            (a['grossSalesMmk'] - b['grossSalesMmk'], (a['cogsMmk'] or 0) - (b['cogsMmk'] or 0)),
            a['grossSalesMmk'] - b['grossSalesMmk'] == 2000 and a['cogsMmk'] - b['cogsMmk'] == 1200)
    r = t.req('c2', s['id'], [item('prod-2', 1, 2000, t.line(s['id'], 'prod-2'), False, [('CASH', 2000)])])
    t.approve('mgr', r)
    t.exp[X2] -= 2000
    c = t.report('shop-a')
    dcogs = c['cogsMmk'] - b['cogsMmk']
    dprofit = (c['grossSalesMmk'] - c['refundMmk'] - c['voidMmk'] - c['cogsMmk']) - (b['grossSalesMmk'] - b['refundMmk'] - b['voidMmk'] - b['cogsMmk'])
    t.check('f72', 'KNOWN-MEDIUM: full refund WITHOUT restock (item damaged / not returned): the goods are gone, so net COGS of the pair must stay 1200 and '
            'profit must be -1200; the report reverses the cost as if restocked', 'dCOGS 1200, dProfit -1200', 'dCOGS %s, dProfit %s' % (dcogs, dprofit),
            dcogs == 1200 and dprofit == -1200)
    s2, _ = t.sale('c2', X2, [{'product_id': 'prod-2', 'qty': 1}], 'CASH', 2000)
    t.exp[X2] += 2000
    d = t.report('shop-a')
    r2 = t.req('c2', s2['id'], [item('prod-2', 1, 2000, t.line(s2['id'], 'prod-2'), True, [('CASH', 2000)])])
    t.approve('mgr', r2)
    t.exp[X2] -= 2000
    e = t.report('shop-a')
    t.check('f73', 'full refund WITH restock: COGS reversed (back in stock), revenue reversed: delta over sale+refund = 0 revenue, 0 COGS',
            (0, 0), (e['grossSalesMmk'] - e['refundMmk'] - (d['grossSalesMmk'] - d['refundMmk']) + 2000, e['cogsMmk'] - d['cogsMmk'] + 1200),
            e['grossSalesMmk'] - e['refundMmk'] == d['grossSalesMmk'] - d['refundMmk'] - 2000 and e['cogsMmk'] == d['cogsMmk'] - 1200)
    # unavailable historical cost (shop-b): a product sold with no cost on record
    t.q("""SELECT test.login('%s') AS zz \\gset
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-fin-nc','FINNC','Fin no-cost product','General','pcs',500,NULL);
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk) VALUES ('unit-fin-nc','prod-fin-nc','pcs',1,true,true,500,NULL);
SELECT test.logout() AS zz \\gset
INSERT INTO inventory (shop_id, product_id, qty_base_units) VALUES ('shop-b','prod-fin-nc',0) ON CONFLICT DO NOTHING;
UPDATE inventory SET qty_base_units = 10 WHERE shop_id='shop-b' AND product_id='prod-fin-nc';
INSERT INTO test.initial_inventory SELECT shop_id, product_id, qty_base_units FROM inventory WHERE product_id='prod-fin-nc'
  ON CONFLICT (shop_id, product_id) DO UPDATE SET qty = EXCLUDED.qty;
SELECT 'ok';""" % U['admin'])
    b = t.report('shop-b')
    s3, _ = t.sale('cb', 'shift-b', [{'product_id': 'prod-fin-nc', 'qty': 2}], 'CASH', 1000, shop='shop-b')
    a = t.report('shop-b')
    t.check('f74', 'unavailable historical cost: before the no-cost sale shop-b profit is complete; after it cogsComplete=false, grossProfit=null, the line counted '
            'missing and NO cost estimated (COGS unchanged)', 'complete->false, profit null, cogs +0, missing +1',
            (b['cogsComplete'], a['cogsComplete'], a['grossProfitMmk'], a['cogsMmk'] - b['cogsMmk'], a['linesMissingCost'] - b['linesMissingCost']),
            b['cogsComplete'] is True and a['cogsComplete'] is False and a['grossProfitMmk'] is None and a['cogsMmk'] == b['cogsMmk']
            and a['linesMissingCost'] == b['linesMissingCost'] + 1)
    r3 = t.req('cb', s3['id'], [item('prod-fin-nc', 1, 500, t.line(s3['id'], 'prod-fin-nc'), True, [('CASH', 500)])])
    t.approve('mgrb', r3)
    c = t.report('shop-b')
    rlc = t.q("SELECT coalesce(min(cost_mmk)::text,'NULL') FROM refund_lines WHERE request_id=%s;" % L(r3))
    t.check('f75', 'refund of the no-cost line: refund line cost NULL (never guessed), adjustment counted as missing cost, profit still null',
            'NULL, missing adj +1, profit null', (rlc, c['adjustmentsMissingCost'] - a['adjustmentsMissingCost'], c['grossProfitMmk'], c['cogsMmk'] - a['cogsMmk']),
            rlc == 'NULL' and c['adjustmentsMissingCost'] == a['adjustmentsMissingCost'] + 1 and c['grossProfitMmk'] is None and c['cogsMmk'] == a['cogsMmk'])
    # void of a split sale: drawer drops by the cash part only
    v, _ = t.split('c2', X2, [{'product_id': 'prod-1', 'qty': 2}], [{'method': 'CASH', 'amountMmk': 600}, {'method': 'CARD', 'amountMmk': 1400}])
    t.exp[X2] += 600
    e0 = t.expected(X2)
    i0 = t.inv('prod-1')
    vr = t.req('c2', v['id'], None, 'VOID')
    t.q("SELECT public.approve_void_request(%s, %s)::text;" % (L(vr), L(t.key())), 'mgr')
    t.exp[X2] -= 600
    t.check('f76', 'void of a split sale (CASH 600 + CARD 1400): drawer -600 (cash part only), stock +2, payments excluded from the payment summary',
            (e0 - 600, i0 + 2), (t.expected(X2), t.inv('prod-1')), t.expected(X2) == e0 - 600 == t.exp[X2] and t.inv('prod-1') == i0 + 2 and t.indep(X2) == t.exp[X2])
    t.refused('f77', 'a voided sale cannot then be refunded', t.req_sql(v['id'], [item('prod-1', 1, 700, t.line(v['id'], 'prod-1'), True, [('CARD', 700)])], t.key()), 'c2', 'voided')


# ---------------------------------------------------------------------------------------------------------- cross-org
def cross_org(t):
    X2 = t.X2
    S = t.S_split['id']
    t.refused('f78', 'other org: fin_complete_sale_split into shop-a / X2', t.split_sql(X2, [{'product_id': 'prod-1', 'qty': 1}], [{'method': 'CASH', 'amountMmk': 1000}], key=t.key()),
              'xmgr', 'not found')
    t.refused('f79', 'other org: fin_close_shift of X2', "SELECT public.fin_close_shift(%s, 0, 'x', NULL, NULL, %s);" % (L(X2), L(t.key())), 'xmgr', 'not found')
    t.refused('f80', 'other org: fin_shift_cash_summary of X2', "SELECT public.fin_shift_cash_summary(%s);" % L(X2), 'xmgr', 'not found')
    t.refused('f81', 'other org: fin_refund_lines_state of a shop-a sale', "SELECT public.fin_refund_lines_state(%s);" % L(S), 'xmgr', 'not found')
    t.refused('f82', 'other org: refund request on a shop-a sale', t.req_sql(S, [item('prod-2', 1, 100)], t.key()), 'xmgr', 'not found')
    pend = t.req('c2', S, [item('prod-2', 1, 100, t.line(S, 'prod-2'), True, [('CARD', 100)])])
    t.refused('f83', 'other org: approve a shop-a refund request', t.approve_sql(pend, t.key()), 'xmgr', 'not found')
    t.refused('f84', 'other org: fin_payment_summary / fin_report_summary for shop-a',
              "SELECT public.fin_payment_summary('shop-a', current_date - 1, current_date + 1);", 'xmgr', 'not permitted')
    t.refused('f85', 'other org: fin_report_summary for shop-a', "SELECT public.fin_report_summary('shop-a', current_date - 1, current_date + 1, 'SALE_DATE');", 'xmgr', 'not permitted')
    t.refused('f86', 'org-test cashier: cash movement on the other org\'s shift', t.mv_sql('shift-unrel', 'PAY_IN', 100, key=t.key()), 'c2', 'not found')
    t.refused('f87', 'org-test manager: refund request on the other org\'s sale', t.req_sql('sale-unrel', [item('prod-1', 1, 100)], t.key()), 'mgr', 'not found')
    t.refused('f88', 'authenticated cannot call the internal fin_shift_cash', "SELECT public.fin_shift_cash(%s);" % L(X2), 'xmgr', 'permission denied')
    t.refused('f89', 'same-org other shop: cashier B requests a refund of a shop-a sale', t.req_sql(S, [item('prod-2', 1, 100)], t.key()), 'cb', 'not permitted')
    t.refused('f90', 'same-org other shop: manager B approves a shop-a refund request', t.approve_sql(pend, t.key()), 'mgrb', 'not permitted')
    t.refused('f91', 'same-org other shop: manager B reads X2 cash summary', "SELECT public.fin_shift_cash_summary(%s);" % L(X2), 'mgrb', 'not permitted')
    t.q("SELECT public.reject_refund_void_request(%s, 'cleanup', %s)::text;" % (L(pend), L(t.key())), 'mgr')
    seen = t.j("""SELECT json_build_object('sp',(SELECT count(*) FROM sale_payments WHERE org_id='org-test'),'cm',(SELECT count(*) FROM cash_movements WHERE org_id='org-test'),
                 'rl',(SELECT count(*) FROM refund_lines WHERE org_id='org-test'),'rp',(SELECT count(*) FROM refund_payouts WHERE org_id='org-test'))::text;""", 'xmgr')
    t.check('f92', 'other org reads none of org-test\'s sale_payments, cash_movements, refund_lines, refund_payouts', {'sp': 0, 'cm': 0, 'rl': 0, 'rp': 0}, seen,
            seen == {'sp': 0, 'cm': 0, 'rl': 0, 'rp': 0})
    seen = t.j("""SELECT json_build_object('sp',(SELECT count(*) FROM sale_payments WHERE org_id='org-unrelated'),'cm',(SELECT count(*) FROM cash_movements WHERE org_id='org-unrelated'))::text;""", 'admin')
    t.check('f93', 'org-test admin reads none of the other org\'s payment rows', {'sp': 0, 'cm': 0}, seen, seen == {'sp': 0, 'cm': 0})
    for i, (tbl, stmt) in enumerate([('sale_payments', "UPDATE sale_payments SET amount_mmk = 1"), ('cash_movements', "INSERT INTO cash_movements (id) VALUES ('x')"),
                                     ('refund_lines', "DELETE FROM refund_lines"), ('refund_payouts', "INSERT INTO refund_payouts (id) VALUES ('x')"),
                                     ('refund_lines', "INSERT INTO refund_lines (id) VALUES ('x')")]):
        t.refused('f94%s' % 'abcde'[i], 'API role cannot write %s directly (%s)' % (tbl, stmt.split()[0]), stmt, 'xmgr', 'permission denied')
    # the same key in two organizations is two independent operations
    k = t.K_split
    rc, out = t.exec(t.mv_sql('shift-unrel', 'PAY_IN', 100, key=k), 'xc')
    ok = rc == 0 and json.loads(out.strip())['movement']['shiftId'] == 'shift-unrel'
    t.check('f95', 'an org-test sale key re-used by the other org is a NEW operation there (per-org ledger): no replay of org-test\'s reply, no mismatch oracle',
            'movement on shift-unrel', out.strip()[-200:], ok)
    probe = t.q("SELECT coalesce(public.fin_split_replay_problem(%s, repeat('0',64)),'NULL');" % L(k), 'xmgr')
    t.check('f96', 'fin_split_replay_problem (granted to authenticated) does not reveal another org\'s split key', 'NULL', probe, probe == 'NULL')


# ------------------------------------------------------------------------------------------------------------- races
def races(t):
    X2 = t.X2

    def two_pending(sale_id, items1, items2, tag):
        k1, k2 = t.key(), t.key()
        s1 = t.session('c2', "BEGIN;\nSELECT 'R:'||(%s);\nSELECT pg_sleep(1.5);\nCOMMIT;" % t.req_sql(sale_id, items1, k1).rstrip(';').replace('SELECT ', '', 1), tag + '-create1')
        t.wait(t.sleeping(tag + '-create1'), s1)
        rc2, o2 = t.exec(t.req_sql(sale_id, items2, k2), 'c1')
        rc1, o1 = t.finish(s1)
        return (t.results_of(o1) or [None])[0], (o2.strip() if rc2 == 0 else None), errmsg(o2) if rc2 else None

    def race_approve(r1, r2, tag):
        s1 = t.session('mgr', "BEGIN;\nSELECT 'R:'||(%s);\nSELECT pg_sleep(2);\nCOMMIT;" % t.approve_sql(r1, t.key()).rstrip(';').replace('SELECT ', '', 1), tag + '-appr1')
        t.wait(t.sleeping(tag + '-appr1'), s1)
        s2 = t.session('admin', "SELECT 'R:'||(%s);" % t.approve_sql(r2, t.key()).rstrip(';').replace('SELECT ', '', 1), tag + '-appr2')
        waited = t.wait(t.blocked(tag + '-appr2'), s2)
        o1, o2 = t.finish(s1), t.finish(s2)
        return waited, o1, o2

    # (a1) two approvals on the same sale exceeding the LINE quantity together
    sa, _ = t.sale('c2', X2, [{'product_id': 'prod-1', 'qty': 3}], 'CASH', 3000)
    t.exp[X2] += 3000
    la = t.line(sa['id'], 'prod-1')
    inv0 = t.inv('prod-1')
    r1, r2, e2 = two_pending(sa['id'], [item('prod-1', 2, 2000, la, True)], [item('prod-1', 2, 2000, la, True)], 'fa1')
    npend = t.q("SELECT count(*) FROM refund_void_requests WHERE sale_id=%s AND status='REQUESTED';" % L(sa['id']))
    t.check('f97', 'two refund requests of the same sale created concurrently are BOTH stored pending: the pinned "one pending request per sale" check is not '
            'concurrency-safe (harmless only because approval re-checks under the sale lock; decide whether a unique pending index is wanted)',
            '2 pending', (npend, e2), npend == '2', 'POLICY')
    if r1 and r2:
        waited, (rc1, o1), (rc2, o2) = race_approve(r1, r2, 'fa1')
        q = t.j("SELECT json_build_object('appr',(SELECT count(*) FROM refund_void_requests WHERE sale_id=%s AND status='APPROVED'),"
                "'qty',(SELECT coalesce(sum(qty_units),0) FROM refund_lines WHERE sale_id=%s))::text;" % (L(sa['id']), L(sa['id'])))
        t.exp[X2] -= 2000 * q['appr']
        t.check('f98', 'race (a1): two concurrent approvals of 2+2 units on a 3-unit line: the second WAITED on the sale lock, exactly one approved, refunded qty 2 <= 3, '
                'stock +2 only', 'waited, 1 approved, qty 2, stock +2', (waited, q, t.inv('prod-1') - inv0, errmsg(o2) if rc2 else 'second succeeded'),
                waited and q == {'appr': 1, 'qty': 2} and t.inv('prod-1') == inv0 + 2 and rc1 == 0 and rc2 != 0)
    else:
        t.check('f98', 'race (a1) setup: two pending requests', 'two pending', (r1, r2, e2), False)
    # (a2) two approvals exceeding the CASH payout cap together (pinned per-product check passes: 1+1 of 2 units)
    sb, _ = t.split('c2', X2, [{'product_id': 'prod-1', 'qty': 2}], [{'method': 'CASH', 'amountMmk': 1000}, {'method': 'CARD', 'amountMmk': 1000}])
    t.exp[X2] += 1000
    lb = t.line(sb['id'], 'prod-1')
    r1, r2, e2 = two_pending(sb['id'], [item('prod-1', 1, 1000, lb, True, [('CASH', 1000)])], [item('prod-1', 1, 1000, lb, True, [('CASH', 1000)])], 'fa2')
    if r1 and r2:
        waited, (rc1, o1), (rc2, o2) = race_approve(r1, r2, 'fa2')
        q = t.j("SELECT json_build_object('appr',(SELECT count(*) FROM refund_void_requests WHERE sale_id=%s AND status='APPROVED'),"
                "'cash',(SELECT coalesce(sum(amount_mmk),0) FROM refund_payouts WHERE sale_id=%s AND method='CASH'))::text;" % (L(sb['id']), L(sb['id'])))
        t.exp[X2] -= q['cash']
        t.check('f99', 'race (a2): two concurrent approvals each paying CASH 1000 on a sale that took CASH 1000: exactly one approved, CASH payouts 1000 (PFIN-E guard under the sale lock)',
                'waited, 1 approved, cash 1000', (waited, q, errmsg(o2) if rc2 else 'second succeeded'),
                waited and q == {'appr': 1, 'cash': 1000} and rc2 != 0 and 'exceeds what the customer paid that way' in o2)
    else:
        t.check('f99', 'race (a2) setup: two pending requests', 'two pending', (r1, r2, e2), False)
    t.check('f100', 'X2 drawer after the refund races', t.exp[X2], t.expected(X2), t.expected(X2) == t.exp[X2] == t.indep(X2))

    # (b) two cash-outs that together exceed the drawer
    e = t.expected(X2)
    amt = e // 2 + 100
    s1 = t.session('mgr', "BEGIN;\nSELECT 'R:'||(%s);\nSELECT pg_sleep(1.5);\nCOMMIT;" % t.mv_sql(X2, 'PAY_OUT', amt, key=t.key()).rstrip(';').replace('SELECT ', '', 1), 'fb-out1')
    t.wait(t.sleeping('fb-out1'), s1)
    s2 = t.session('admin', "SELECT 'R:'||(%s);" % t.mv_sql(X2, 'DEPOSIT_OUT', amt, key=t.key()).rstrip(';').replace('SELECT ', '', 1), 'fb-out2')
    waited = t.wait(t.blocked('fb-out2'), s2)
    (rc1, o1), (rc2, o2) = t.finish(s1), t.finish(s2)
    n = int(t.q("SELECT count(*) FROM cash_movements WHERE shift_id=%s AND kind IN ('PAY_OUT','DEPOSIT_OUT') AND amount_mmk=%d;" % (L(X2), amt)))
    t.exp[X2] -= amt * n
    t.check('f101', 'race (b): two concurrent cash-outs of %d each from a drawer of %d: the second waited on the shift lock and was refused; drawer never negative' % (amt, e),
            'waited, 1 row, drawer >= 0', (waited, n, t.expected(X2), errmsg(o2) if rc2 else 'second succeeded'),
            waited and n == 1 and rc2 != 0 and 'cannot be taken out' in o2 and t.expected(X2) == t.exp[X2] >= 0)

    # (d) duplicate same-key split submissions in parallel
    k = t.key()
    items = [{'product_id': 'prod-3', 'qty': 1}]
    pays = [{'method': 'CASH', 'amountMmk': 2000, 'tenderedMmk': 2500}, {'method': 'CARD', 'amountMmk': 1000}]
    s1 = t.session('c2', "BEGIN;\nSELECT 'R:'||(%s);\nSELECT pg_sleep(1.5);\nCOMMIT;" % t.split_sql(X2, items, pays, key=k).rstrip(';').replace('SELECT ', '', 1), 'fd-dup1')
    t.wait(t.sleeping('fd-dup1'), s1)
    s2 = t.session('c2', "SELECT 'R:'||(%s);" % t.split_sql(X2, items, list(reversed(pays)), key=k).rstrip(';').replace('SELECT ', '', 1), 'fd-dup2')
    waited = t.wait(t.blocked('fd-dup2'), s2)
    (rc1, o1), (rc2, o2) = t.finish(s1), t.finish(s2)
    ids = [json.loads(x)['sale']['id'] for x in t.results_of(o1) + t.results_of(o2)]
    n = t.j("SELECT json_build_object('sales',(SELECT count(DISTINCT sale_id) FROM sale_payments WHERE op_key=%s),'rows',(SELECT count(*) FROM sale_payments WHERE op_key=%s))::text;" % (L(k), L(k)))
    t.exp[X2] += 2000 * n['sales']
    t.check('f102', 'race (d1): the same split sale (same key) submitted twice in parallel: second waited, both replies name ONE sale, 2 payment rows',
            'waited, 1 sale', (waited, rc1, rc2, len(set(ids)), n), waited and rc1 == 0 and rc2 == 0 and len(ids) == 2 and len(set(ids)) == 1 and n == {'sales': 1, 'rows': 2})
    k = t.key()
    pays_b = [{'method': 'CASH', 'amountMmk': 1500, 'tenderedMmk': 2000}, {'method': 'CARD', 'amountMmk': 1500}]   # same paid 3500 and method: only the split differs
    s1 = t.session('c2', "BEGIN;\nSELECT 'R:'||(%s);\nSELECT pg_sleep(1.5);\nCOMMIT;" % t.split_sql(X2, items, pays, key=k).rstrip(';').replace('SELECT ', '', 1), 'fd-diff1')
    t.wait(t.sleeping('fd-diff1'), s1)
    s2 = t.session('c2', "SELECT 'R:'||(%s);" % t.split_sql(X2, items, pays_b, key=k).rstrip(';').replace('SELECT ', '', 1), 'fd-diff2')
    waited = t.wait(t.blocked('fd-diff2'), s2)
    (rc1, o1), (rc2, o2) = t.finish(s1), t.finish(s2)
    n = t.j("SELECT json_build_object('sales',(SELECT count(DISTINCT sale_id) FROM sale_payments WHERE op_key=%s),'cash',(SELECT sum(amount_mmk) FROM sale_payments WHERE op_key=%s AND method='CASH'))::text;" % (L(k), L(k)))
    t.exp[X2] += 2000 * n['sales']
    t.check('f103', 'race (d2): same key, same sale arguments, DIFFERENT split in parallel (the pre-check cannot see the uncommitted first): the second is refused '
            'after the replay (FIN_PAYMENTS_MISMATCH); only the first split is stored', 'waited, 1 sale, cash 2000, second MISMATCH',
            (waited, n, errmsg(o2) if rc2 else 'second succeeded'), waited and n == {'sales': 1, 'cash': 2000} and rc2 != 0 and 'FIN_PAYMENTS_MISMATCH' in o2)
    # plain complete_sale duplicates in parallel
    k = t.key()
    body = t.sale_sql(X2, [{'product_id': 'prod-1', 'qty': 1}], 'CASH', 1000, 0, k).rstrip(';').replace('SELECT ', '', 1)
    s1 = t.session('c2', "BEGIN;\nSELECT 'R:'||(%s);\nSELECT pg_sleep(1.5);\nCOMMIT;" % body, 'fd-plain1')
    t.wait(t.sleeping('fd-plain1'), s1)
    s2 = t.session('c2', "SELECT 'R:'||(%s);" % body, 'fd-plain2')
    waited = t.wait(t.blocked('fd-plain2'), s2)
    (rc1, o1), (rc2, o2) = t.finish(s1), t.finish(s2)
    ids = [json.loads(x)['sale']['id'] for x in t.results_of(o1) + t.results_of(o2)]
    cnt = int(t.q("SELECT count(*) FROM inventory_movements WHERE type='SALE_OUT' AND reference_id IN (%s);" % ','.join(L(i) for i in set(ids)) if ids else "SELECT 0;"))
    t.exp[X2] += 1000 * len(set(ids))
    t.check('f104', 'race (d3): plain complete_sale with the same key twice in parallel: one sale, one SALE_OUT, both replies equal',
            '1 sale, 1 movement', (waited, len(set(ids)), cnt), waited and len(ids) == 2 and len(set(ids)) == 1 and cnt == 1)

    # (c1) sale committed while fin_close_shift waits: the close includes it
    eb = t.expected(X2)
    s1 = t.session('c2', "BEGIN;\nSELECT 'R:'||(%s);\nSELECT pg_sleep(1.5);\nCOMMIT;" % t.sale_sql(X2, [{'product_id': 'prod-1', 'qty': 1}], 'CASH', 1000, 0, t.key()).rstrip(';').replace('SELECT ', '', 1), 'fc-sale')
    t.wait(t.sleeping('fc-sale'), s1)
    s2 = t.session('mgr', "SELECT 'R:'||(public.fin_close_shift(%s, %d, 'closing during a sale', NULL, NULL, %s)::text);" % (L(X2), eb, L(t.key())), 'fc-close')
    waited = t.wait(t.blocked('fc-close'), s2)
    (rc1, o1), (rc2, o2) = t.finish(s1), t.finish(s2)
    t.exp[X2] += 1000
    st = t.j("SELECT json_build_object('e',expected_cash_mmk,'v',variance_mmk,'closed',ended_at IS NOT NULL)::text FROM shifts WHERE id=%s;" % L(X2))
    t.check('f105', 'race (c1): sale vs fin_close_shift, sale first: the close waited, then stored expected INCLUDING the sale (= independent formula), variance -1000',
            {'e': t.exp[X2], 'v': -1000, 'closed': True}, (waited, st, t.indep(X2), errmsg(o2) if rc2 else 'ok'),
            waited and rc1 == 0 and rc2 == 0 and st == {'e': t.exp[X2], 'v': -1000, 'closed': True} and t.indep(X2) == t.exp[X2])
    # (c2) close first: a sale arriving during the close is refused, nothing written
    X3 = t.open_shift('c2', 1000)
    t.X3 = X3
    s1 = t.session('mgr', "BEGIN;\nSELECT 'R:'||(public.fin_close_shift(%s, 1000, NULL, NULL, NULL, %s)::text);\nSELECT pg_sleep(1.5);\nCOMMIT;" % (L(X3), L(t.key())), 'fc-close2')
    t.wait(t.sleeping('fc-close2'), s1)
    before = t.state()
    s2 = t.session('c2', "SELECT 'R:'||(%s);" % t.sale_sql(X3, [{'product_id': 'prod-1', 'qty': 1}], 'CASH', 1000, 0, t.key()).rstrip(';').replace('SELECT ', '', 1), 'fc-sale2')
    waited = t.wait(t.blocked('fc-sale2'), s2)
    (rc1, o1), (rc2, o2) = t.finish(s1), t.finish(s2)
    after = t.state()
    diff = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
    t.check('f106', 'race (c2): fin_close_shift first, a sale arrives during the close: the sale waited, then was refused (no open shift); only the close was written',
            'waited, refused, only closed+1/audit/idem', (waited, errmsg(o2) if rc2 else 'sale succeeded', diff),
            waited and rc2 != 0 and 'No open shift' in o2 and set(diff) <= {'closed', 'audit', 'idem'})
    # two closes at once
    X4 = t.open_shift('c2', 0)
    t.X4 = X4
    s1 = t.session('mgr', "BEGIN;\nSELECT 'R:'||(public.fin_close_shift(%s, 0, NULL, NULL, NULL, %s)::text);\nSELECT pg_sleep(1.0);\nCOMMIT;" % (L(X4), L(t.key())), 'fe-close1')
    t.wait(t.sleeping('fe-close1'), s1)
    s2 = t.session('c2', "SELECT 'R:'||(public.fin_close_shift(%s, 0, NULL, NULL, NULL, %s)::text);" % (L(X4), L(t.key())), 'fe-close2')
    waited = t.wait(t.blocked('fe-close2'), s2)
    (rc1, o1), (rc2, o2) = t.finish(s1), t.finish(s2)
    t.check('f107', 'race: two fin_close_shift of the same shift: one closes, the other waits and is refused (already closed); one SHIFT_CLOSED audit',
            'waited, 1 close', (waited, rc1, errmsg(o2) if rc2 else 'second succeeded',
                                t.q("SELECT count(*) FROM audit_logs WHERE action_type='SHIFT_CLOSED' AND entity_id=%s;" % L(X4))),
            waited and rc1 == 0 and rc2 != 0 and 'already closed' in o2 and t.q("SELECT count(*) FROM audit_logs WHERE action_type='SHIFT_CLOSED' AND entity_id=%s;" % L(X4)) == '1')


# ------------------------------------------------------------------------------------------------------------ crashes
def crashes(t):
    X5 = t.open_shift('c2', 2000)
    t.X5 = X5
    t.exp[X5] = 2000

    def crash(who, body, app):
        before = t.state()
        s = t.session(who, "BEGIN;\nSELECT 'R:'||(%s);\nSELECT pg_sleep(30);\nCOMMIT;" % body.rstrip(';').replace('SELECT ', '', 1), app)
        slept = t.wait(t.sleeping(app), s)
        term = t.q("SELECT bool_or(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name='%s';" % app)
        rc, out = t.finish(s)
        after = t.state()
        return slept and term == 't' and rc != 0 and t.results_of(out), {k: (before[k], after[k]) for k in before if before[k] != after[k]}, out

    # split sale terminated mid-transaction
    k = t.key()
    items = [{'product_id': 'prod-1', 'qty': 2}]
    pays = [{'method': 'CASH', 'amountMmk': 1500, 'tenderedMmk': 2000}, {'method': 'MOBILE_WALLET', 'amountMmk': 500}]
    inv3 = t.inv('prod-1')
    ok, diff, out = crash('c2', t.split_sql(X5, items, pays, key=k), 'fk-split')
    led = t.q("SELECT count(*) FROM idempotency_keys WHERE key=%s;" % L(k))
    t.check('f108', 'crash: backend terminated while a split sale transaction was open (after the RPC returned): nothing partial remains '
            '(no sale, payment, stock, movement, audit or ledger row)', 'no change', (ok, diff, led, t.inv('prod-1') - inv3),
            ok and diff == {} and led == '0' and t.inv('prod-1') == inv3)
    r1, _ = t.split('c2', X5, items, pays, key=k)
    before = t.state()
    r2, _ = t.split('c2', X5, items, pays, key=k)
    after = t.state()
    t.exp[X5] += 1500
    n = t.j("SELECT json_build_object('sales',(SELECT count(DISTINCT sale_id) FROM sale_payments WHERE op_key=%s),'stock',(SELECT qty_base_units FROM inventory WHERE shop_id='shop-a' AND product_id='prod-1'))::text;" % L(k))
    t.check('f109', 'crash retry: the same key then succeeds exactly once (retry of the retry replays, no new rows); stock -2 once; drawer +1500 (cash part)',
            '1 sale, stock -2', (r1['id'] == r2['id'], before == after, n, t.expected(X5)),
            r1['id'] == r2['id'] and before == after and n == {'sales': 1, 'stock': inv3 - 2} and t.expected(X5) == t.exp[X5])
    # approval terminated mid-transaction
    S = r1['id']
    rq = t.req('c2', S, [item('prod-1', 1, 1000, t.line(S, 'prod-1'), False, [('CASH', 600), ('MOBILE_WALLET', 400)])])
    ka = t.key()
    st0 = t.q("SELECT status FROM sales WHERE id=%s;" % L(S))
    ok, diff, out = crash('mgr', t.approve_sql(rq, ka), 'fk-approve')
    rstat = t.q("SELECT status FROM refund_void_requests WHERE id=%s;" % L(rq))
    t.check('f110', 'crash: approval terminated mid-transaction: request still REQUESTED, sale status unchanged, no refund line / payout / RETURN_IN / RETURN_NO_RESTOCK / ledger row',
            'REQUESTED, no change', (ok, rstat, diff, t.q("SELECT status FROM sales WHERE id=%s;" % L(S)) == st0, t.q("SELECT count(*) FROM idempotency_keys WHERE key=%s;" % L(ka))),
            ok and rstat == 'REQUESTED' and diff == {} and t.q("SELECT status FROM sales WHERE id=%s;" % L(S)) == st0 and t.q("SELECT count(*) FROM idempotency_keys WHERE key=%s;" % L(ka)) == '0')
    a1 = t.approve('mgr', rq, ka)
    before = t.state()
    a2 = t.approve('mgr', rq, ka)
    after = t.state()
    t.exp[X5] -= 600
    q = t.j("SELECT json_build_object('rl',(SELECT count(*) FROM refund_lines WHERE request_id=%s),'rp',(SELECT count(*) FROM refund_payouts WHERE request_id=%s),"
            "'nr',(SELECT count(*) FROM inventory_movements WHERE reference_id=%s AND type='RETURN_NO_RESTOCK'))::text;" % (L(rq), L(rq), L(rq)))
    t.check('f111', 'crash retry: approval with the same key succeeds exactly once (replay identical, no new rows): 1 line, 2 payouts, 1 RETURN_NO_RESTOCK; stock net -2; drawer -600',
            {'rl': 1, 'rp': 2, 'nr': 1}, (a1 == a2, before == after, q, t.inv('prod-1') - inv3, t.expected(X5)),
            a1 == a2 and before == after and q == {'rl': 1, 'rp': 2, 'nr': 1} and t.inv('prod-1') == inv3 - 2 and t.expected(X5) == t.exp[X5])
    # cash movement + close terminated mid-transaction
    km = t.key()
    ok, diff, out = crash('mgr', t.mv_sql(X5, 'PAY_OUT', 500, key=km), 'fk-move')
    t.check('f112', 'crash: cash movement terminated mid-transaction leaves no movement / audit / ledger row', 'no change', (ok, diff), ok and diff == {})
    t.mv('mgr', X5, 'PAY_OUT', 500)
    t.exp[X5] -= 500
    kc = t.key()
    ok, diff, out = crash('c2', "SELECT public.fin_close_shift(%s, %d, NULL, NULL, NULL, %s)::text;" % (L(X5), t.exp[X5], L(kc)), 'fk-close')
    t.check('f113', 'crash: fin_close_shift terminated mid-transaction: shift still open, nothing stored', 'open, no change',
            (ok, diff, t.q("SELECT ended_at IS NULL FROM shifts WHERE id=%s;" % L(X5))), ok and diff == {} and t.q("SELECT ended_at IS NULL FROM shifts WHERE id=%s;" % L(X5)) == 't')
    t.q("SELECT public.fin_close_shift(%s, %d, NULL, NULL, NULL, %s)::text;" % (L(X5), t.exp[X5], L(kc)), 'c2')
    st = t.j("SELECT json_build_object('e',expected_cash_mmk,'v',variance_mmk)::text FROM shifts WHERE id=%s;" % L(X5))
    t.check('f114', 'crash retry: close with the same key stores 2000 + 1500 - 600 - 500 = 2400 (= independent formula), variance 0',
            {'e': 2400, 'v': 0}, (st, t.indep(X5)), st == {'e': 2400, 'v': 0} and t.indep(X5) == 2400)


# ---------------------------------------------------------------------------------------------- drawer / report methods
def drawer_and_methods(t):
    X6 = t.open_shift('c1', 0)
    t.X6 = X6

    def bym():
        r = t.j("SELECT public.fin_report_summary('shop-a', (now() AT TIME ZONE 'Asia/Yangon')::date - 1, (now() AT TIME ZONE 'Asia/Yangon')::date + 1, 'SALE_DATE')->'byPaymentMethod';", 'admin')
        return {m['method']: m['grossSalesMmk'] for m in r}

    def pay():
        r = t.j("SELECT public.fin_payment_summary('shop-a', (now() AT TIME ZONE 'Asia/Yangon')::date - 1, (now() AT TIME ZONE 'Asia/Yangon')::date + 1)->'payments';", 'admin')
        return {k: int(v) for k, v in r.items()}

    def delta(a, b):
        return {m: a.get(m, 0) - b.get(m, 0) for m in set(a) | set(b) if a.get(m, 0) != b.get(m, 0)}
    b, pb = bym(), pay()
    s, _ = t.split('c1', X6, [{'product_id': 'prod-1', 'qty': 4}], [{'method': 'CASH', 'amountMmk': 1000}, {'method': 'CARD', 'amountMmk': 3000}])
    a, pa = bym(), pay()
    t.check('f124', 'reports agree on a split sale (CASH 1000 + CARD 3000): fin_report_summary.byPaymentMethod must show CASH +1000 / CARD +3000 like fin_payment_summary',
            {'CASH': 1000, 'CARD': 3000}, 'byPaymentMethod %s, fin_payment_summary %s' % (delta(a, b), delta(pa, pb)),
            delta(a, b) == {'CASH': 1000, 'CARD': 3000} and delta(pa, pb) == {'CASH': 1000, 'CARD': 3000})
    t.mv('mgr', X6, 'DEPOSIT_OUT', 1000)
    r = t.req('c1', s['id'], [item('prod-1', 2, 2000, t.line(s['id'], 'prod-1'), True, [('CASH', 1000), ('CARD', 1000)])])
    t.approve('mgr', r)
    t.check('f125', 'a CASH refund payout is not limited by the drawer: with 0 MMK expected, a 1000 CASH payout is approved and expected cash becomes -1000 '
            '(owner decision with P-3 / P-8: refuse, route to the safe, or allow)', -1000, t.expected(X6), t.expected(X6) == -1000 == t.indep(X6), 'POLICY')
    t.q("SELECT public.fin_close_shift(%s, 0, 'refund paid from the safe', NULL, NULL, %s)::text;" % (L(X6), L(t.key())), 'c1')
    st = t.j("SELECT json_build_object('e',expected_cash_mmk,'v',variance_mmk)::text FROM shifts WHERE id=%s;" % L(X6))
    t.check('f126', 'a negative expected drawer closes with the authoritative figure (-1000) and variance +1000 with a reason', {'e': -1000, 'v': 1000}, st, st == {'e': -1000, 'v': 1000})


# --------------------------------------------------------------------------------------------------------- invariants
def invariants(t):
    bad = t.q("""SELECT count(*) FROM sales s WHERE s.total_mmk > 0 AND s.total_mmk IS DISTINCT FROM (SELECT sum(amount_mmk) FROM sale_payments p WHERE p.sale_id=s.id);""")
    t.check('f115', 'invariant: every sale\'s applied payments add up to its total (whole database)', 0, bad, bad == '0')
    bad = t.q("""SELECT count(*) FROM sales s WHERE EXISTS (SELECT 1 FROM sale_payments p WHERE p.sale_id=s.id AND p.source='split')
                 AND (s.paid_mmk <> (SELECT sum(tendered_mmk) FROM sale_payments WHERE sale_id=s.id)
                   OR s.change_mmk <> (SELECT coalesce(sum(tendered_mmk-amount_mmk),0) FROM sale_payments WHERE sale_id=s.id AND method='CASH')
                   OR EXISTS (SELECT 1 FROM sale_payments WHERE sale_id=s.id AND method<>'CASH' AND tendered_mmk<>amount_mmk));""")
    t.check('f116', 'invariant: split sales: paid = sum tendered, change = cash excess only, no non-cash change', 0, bad, bad == '0')
    bad = t.j("""SELECT coalesce(json_agg(x),'[]')::text FROM (SELECT i.shop_id, i.product_id, i.qty_base_units, coalesce(ii.qty,0) init,
                   coalesce((SELECT sum(qty_change) FROM inventory_movements m WHERE m.shop_id=i.shop_id AND m.product_id=i.product_id),0) mv
                 FROM inventory i LEFT JOIN test.initial_inventory ii ON ii.shop_id=i.shop_id AND ii.product_id=i.product_id) x
                WHERE x.qty_base_units <> x.init + x.mv;""")
    t.check('f117', 'invariant: inventory.qty_base_units = initial + sum(inventory_movements.qty_change) for every shop/product (incl. RETURN_IN + RETURN_NO_RESTOCK)',
            '[]', bad, bad == [])
    bad = t.j("""SELECT coalesce(json_agg(x),'[]')::text FROM (SELECT n.item_id, n.qty_units, n.net_mmk, sum(rl.qty_units) q, sum(rl.amount_mmk) a
                 FROM refund_lines rl JOIN LATERAL fin_sale_line_net(ARRAY[rl.sale_id]) n ON n.item_id = rl.sale_item_id
                 GROUP BY 1,2,3 HAVING sum(rl.qty_units) > n.qty_units OR sum(rl.amount_mmk) > n.net_mmk) x;""")
    t.check('f118', 'invariant: no sale line refunded beyond its quantity or net paid amount (attributed refund lines)', '[]', bad, bad == [])
    bad = t.j("""SELECT coalesce(json_agg(x),'[]')::text FROM (SELECT rp.sale_id, rp.method, sum(rp.amount_mmk) out,
                   (SELECT coalesce(sum(amount_mmk),0) FROM sale_payments sp WHERE sp.sale_id=rp.sale_id AND sp.method=rp.method) paid
                 FROM refund_payouts rp GROUP BY 1,2) x WHERE x.out > x.paid;""")
    t.check('f119', 'invariant: refund payouts per sale and method never exceed what that method paid', '[]', bad, bad == [])
    bad = t.q("""SELECT count(*) FROM refund_void_requests r WHERE r.status='APPROVED' AND r.type='PARTIAL' AND EXISTS (SELECT 1 FROM refund_payouts WHERE request_id=r.id)
                 AND (SELECT sum(amount_mmk) FROM refund_payouts WHERE request_id=r.id) <> (SELECT sum((i->>'amountMmk')::bigint) FROM jsonb_array_elements(r.items) i);""")
    t.check('f120', 'invariant: every request\'s payout rows add up to its item amounts', 0, bad, bad == '0')
    bad = t.q("""SELECT count(*) FROM cash_movements r JOIN cash_movements o ON o.id=r.reverses_id
                 WHERE r.kind<>'REVERSAL' OR o.kind='REVERSAL' OR r.shift_id<>o.shift_id OR r.direction<>-o.direction OR r.amount_mmk<>o.amount_mmk;""")
    t.check('f121', 'invariant: every reversal is on the same shift, opposite direction, full amount, never of a reversal', 0, bad, bad == '0')
    rows = t.j("""SELECT coalesce(json_agg(json_build_object('id',id,'e',expected_cash_mmk)),'[]')::text FROM shifts WHERE id = ANY(ARRAY[%s]);""" %
               ','.join(L(x) for x in [getattr(t, a) for a in ('X2', 'X3', 'X4', 'X5', 'X6') if hasattr(t, a)]))
    bad = [r for r in rows if r['e'] != t.indep(r['id'])]
    t.check('f122', 'invariant: every shift closed by these tests (with no later activity) stores the independently computed expected cash', '[]', bad, bad == [])
    bad = t.q("SELECT count(*) FROM shifts WHERE ended_at IS NULL AND shop_id='shop-a' AND (SELECT count(*) FROM shifts s2 WHERE s2.cashier_id=shifts.cashier_id AND s2.ended_at IS NULL) > 1;")
    t.check('f123', 'invariant: no cashier has two open shifts', 0, bad, bad == '0')
