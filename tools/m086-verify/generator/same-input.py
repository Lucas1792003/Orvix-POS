"""Compare a committed generator input with a freshly extracted one
(JSON: same value; text: same set of lines). Exit 0 when identical."""
import json, sys
a, b = sys.argv[1], sys.argv[2]
if a.endswith(".json"):
    ok = json.load(open(a)) == json.load(open(b))
else:
    ok = sorted(l for l in open(a).read().split("\n") if l.strip()) == sorted(l for l in open(b).read().split("\n") if l.strip())
print(f"{a.rsplit('/', 1)[-1]}: {'identical' if ok else 'DIFFERS'}")
sys.exit(0 if ok else 1)
