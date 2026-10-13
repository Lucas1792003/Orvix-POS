# Hosted Supabase — roadmap

- [ ] At cutover: start a daily read-only keep-alive (`SELECT 1`) so the project cannot pause during the rollback window.
- [ ] Keep unchanged for ≥ 30 days after the 1.0.16 rollout (gate G14).
- [ ] At G14: owner decides to pause or delete the project; keep the 2026-10-11 golden export permanently (in the encrypted offsite bundle once Phase F is live).
- [ ] Owner decision: whether to disable hosted's `rotate-audit-log` cron before retirement (it is a hosted change — needs approval).
