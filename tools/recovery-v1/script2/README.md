# Recovery Script 2: adversarial and end-to-end validation modules

Test modules for `tools/recovery-v1/db/db-smoke.py --script2-pre FILE` (after the financial smoke, before Recovery V1)
and `--script2-post FILE` (after Recovery V1 and the Step 4 suite). A `.sql` file runs like the other smokes
(`test.check` / `test.expect_error`); a `.py` module exposes `run(ctx)` (ctx: sql, file, command, check, run, dbargs,
env, sock, data, ROOT, sim, keydir, args, phase). Everything runs on the harness's private, disposable cluster.
Synthetic data and synthetic keys only.
