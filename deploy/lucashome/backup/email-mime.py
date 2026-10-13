#!/usr/bin/env python3
"""email-mime.py - build one outgoing message for the email tier (stdlib only).

  email-mime.py eml         --from F --to A[,B] --subject S --text-file T [--html-file H]
                            --message-id ID --out FILE [--attach PATH[::NAME[::MIME]]]...
  email-mime.py resend-json (same arguments)  -> JSON body for POST https://api.resend.com/emails

`eml` writes an RFC 5322 message (CRLF line endings, base64 attachments) that
curl uploads over SMTP. `resend-json` writes the Resend API payload with the
attachments base64-encoded in `content` and the Message-ID in `headers`.
Nothing is sent from here; the caller (email-lib.sh mail_send) does that.
"""
import argparse
import base64
import json
import os
import sys
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formatdate


def parse_attach(spec):
    parts = spec.split("::")
    path = parts[0]
    name = parts[1] if len(parts) > 1 and parts[1] else os.path.basename(path)
    mime = parts[2] if len(parts) > 2 and parts[2] else "application/octet-stream"
    if not os.path.isfile(path):
        sys.exit(f"email-mime: attachment not found: {path}")
    return path, name, mime


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["eml", "resend-json"])
    ap.add_argument("--from", dest="sender", required=True)
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--html-file")
    ap.add_argument("--message-id", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--attach", action="append", default=[])
    a = ap.parse_args()

    to = [x.strip() for x in a.to.split(",") if x.strip()]
    if not to:
        sys.exit("email-mime: no recipients")
    with open(a.text_file, encoding="utf-8") as fh:
        text = fh.read()
    html = None
    if a.html_file:
        with open(a.html_file, encoding="utf-8") as fh:
            html = fh.read()
    attachments = [parse_attach(s) for s in a.attach]

    old = os.umask(0o077)
    try:
        if a.kind == "eml":
            msg = EmailMessage(policy=SMTP)
            msg["From"] = a.sender
            msg["To"] = ", ".join(to)
            msg["Subject"] = a.subject
            msg["Date"] = formatdate(usegmt=True)
            msg["Message-ID"] = a.message_id
            msg["Auto-Submitted"] = "auto-generated"
            msg.set_content(text)
            if html is not None:
                msg.add_alternative(html, subtype="html")
            for path, name, mime in attachments:
                maintype, _, subtype = mime.partition("/")
                with open(path, "rb") as fh:
                    msg.add_attachment(fh.read(), maintype=maintype, subtype=subtype or "octet-stream", filename=name)
            with open(a.out, "wb") as fh:
                fh.write(msg.as_bytes())
        else:
            body = {
                "from": a.sender,
                "to": to,
                "subject": a.subject,
                "text": text,
                "headers": {"Message-ID": a.message_id, "Auto-Submitted": "auto-generated"},
            }
            if html is not None:
                body["html"] = html
            if attachments:
                body["attachments"] = []
                for path, name, mime in attachments:
                    with open(path, "rb") as fh:
                        body["attachments"].append({
                            "filename": name,
                            "content": base64.b64encode(fh.read()).decode("ascii"),
                            "content_type": mime,
                        })
            with open(a.out, "w", encoding="utf-8") as fh:
                json.dump(body, fh)
    finally:
        os.umask(old)


if __name__ == "__main__":
    main()
