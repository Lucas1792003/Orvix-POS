#!/usr/bin/env python3
"""Minimal SMTP server for fault-injection tests (stdlib only, plain SMTP, no auth).

  smtp-stub.py --port P --dir D [--accept N] [--max-size BYTES]

--accept N    accept the first N messages (250), then answer every later DATA with
              421 and close the connection ("server went away mid-way").
--max-size B  advertise SIZE B and answer 552 after DATA for larger messages.
Accepted messages are stored as D/NNN.eml. Synthetic test traffic only.
"""
import argparse
import os
import socketserver
import threading

lock = threading.Lock()
state = {"accepted": 0}


class Handler(socketserver.StreamRequestHandler):
    def send(self, line):
        self.wfile.write((line + "\r\n").encode())
        self.wfile.flush()

    def handle(self):
        cfg = self.server.cfg
        self.send("220 phf-smtp-stub ESMTP")
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            cmd = raw.decode("latin-1").strip()
            up = cmd.upper()
            if up.startswith("EHLO"):
                self.wfile.write(b"250-phf-smtp-stub\r\n")
                if cfg.max_size:
                    self.wfile.write(f"250-SIZE {cfg.max_size}\r\n".encode())
                self.send("250 8BITMIME")
            elif up.startswith("HELO"):
                self.send("250 phf-smtp-stub")
            elif up.startswith("MAIL FROM") or up.startswith("RCPT TO") or up.startswith("RSET") or up.startswith("NOOP"):
                self.send("250 OK")
            elif up == "DATA":
                self.send("354 go ahead")
                buf = bytearray()
                while True:
                    line = self.rfile.readline()
                    if not line or line in (b".\r\n", b".\n"):
                        break
                    buf += line
                with lock:
                    over = cfg.accept is not None and state["accepted"] >= cfg.accept
                    if over:
                        self.send("421 service shutting down (stub)")
                        return
                    if cfg.max_size and len(buf) > cfg.max_size:
                        self.send("552 5.3.4 message size exceeds fixed limit (stub)")
                        continue
                    state["accepted"] += 1
                    n = state["accepted"]
                with open(os.path.join(cfg.dir, f"{n:03d}.eml"), "wb") as fh:
                    fh.write(bytes(buf))
                self.send(f"250 OK queued as stub{n}")
            elif up == "QUIT":
                self.send("221 bye")
                return
            else:
                self.send("502 not implemented")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--accept", type=int)
    ap.add_argument("--max-size", type=int, default=0)
    cfg = ap.parse_args()
    os.makedirs(cfg.dir, exist_ok=True)
    srv = Server(("127.0.0.1", cfg.port), Handler)
    srv.cfg = cfg
    srv.serve_forever()


if __name__ == "__main__":
    main()
