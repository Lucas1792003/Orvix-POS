# Phase F: sending backup email with no domain, at $0

Retrieved **2026-10-13** (all quotes and DNS lookups). Research only: no sign-ups, no billing, nothing sent, no code changes.
This file extends [cost-research.md](cost-research.md) (quotas and sizes) and [free-tier-compliance.md](free-tier-compliance.md) (terms). It does not repeat what those files already verified.

**Scenario.** The home Ubuntu server sends three kinds of mail to one dedicated **backup Gmail** mailbox:
- **Weekly encrypted archive (gpg).** About 8.5 MB encoded today, in one email. As it grows it will be split into parts of at most 15 MB raw (about 20.5 MB encoded), so 2–4 emails a week within a year.
- **Daily plaintext business summary** (aggregate figures only).
- **Failure alerts.**

**Constraints:** $0 recurring cost, **no purchased domain**, and no paid services.

Legend: **Verified** = quoted from the cited official page or a live DNS lookup. **Unverified** = inferred or third-party; test before relying on it.

---

## 1. Facts that apply to every option

### 1.1 Gmail's DMARC policy decides who can use a `@gmail.com` From address

Live DNS lookups, 2026-10-13:

| Domain | `_dmarc` TXT |
|---|---|
| gmail.com | `v=DMARC1; p=none; sp=quarantine; rua=mailto:mailauth-reports@google.com` |
| resend.dev | `v=DMARC1; p=reject; pct=100; …` (SPF: `include:_spf.google.com -all`) |
| yahoo.com | `p=reject` |
| gmx.net | `p=quarantine` |
| outlook.com | `p=none; sp=quarantine` |

- gmail.com publishes **`p=none`** today. Google has announced it will tighten this: "Don't impersonate Gmail From: headers. Gmail will begin using a DMARC quarantine enforcement policy, and impersonating Gmail From: headers might impact your email delivery." [G-SR]
- Google's rules for **all** senders since 2024-02-01 [G-SR]:
  - "Set up SPF or DKIM email authentication for your sending domains."
  - "Ensure that sending domains or IPs have valid forward and reverse DNS records, also referred to as PTR records."
  - "Use a TLS connection for transmitting email."
  - "Keep spam rates reported in Postmaster Tools below 0.3%."
  - Bulk-sender rules (DMARC alignment and more) start at "more than 5,000 messages per day". We send fewer than 10 a day, so those rules don't apply.
- **What this means.** A third-party relay (Brevo, SMTP2GO, Mailjet and others) **cannot DKIM-sign as gmail.com**. A `From: x@gmail.com` sent through one fails DMARC alignment. Today that lands as `p=none` (spam-folder risk); once Google moves to quarantine, it goes to spam.
  - SMTP2GO says so outright for its single-sender option: "Note that this excludes Gmail, due to their DMARC record, which prevents third-party servers from sending emails on their behalf." [S2G-VS]
  - Brevo rewrites free-mail senders (see §2.4).
- **Only two kinds of sender are clean without a domain:**
  - Google's own servers sending as the Gmail account (SMTP or the Gmail API). These are DKIM-aligned to gmail.com.
  - A provider's own shared domain, such as `onboarding@resend.dev`. Resend signs that domain itself, and it publishes `p=reject`, so Resend must be aligning it.

### 1.2 Gmail attachment blocking (receiving side)

Gmail's blocked list, verbatim [G-BLK]:

> .ade, .adp, .apk, .appx, .appxbundle, .bat, .cab, .chm, .cmd, .com, .cpl, .diagcab, .diagcfg, .diagpkg, .dll, .dmg, .ex, .ex_, .exe, .hta, .img, .ins, .iso, .isp, .jar, .jnlp, .js, .jse, .lib, .lnk, .mde, .mjs, .msc, .msi, .msix, .msixbundle, .msp, .mst, .nsh, .pif, .ps1, .scr, .sct, .shb, .sys, .vb, .vbe, .vbs, .vhd, .vxd, .wsc, .wsf, .wsh, .xll

Gmail also blocks "Password-protected archives with archived content", and blocked types "in their compressed form (like .gz or .bz2 files) or when found within archives (like .zip or .tgz files)". [G-BLK]

- **`.gpg`, `.asc`, `.pgp`, `.bin` and `.001` are not on the list.** A gpg file is not a zip, rar or 7z archive, so the "password-protected archive" rule shouldn't trigger. **Unverified:** Gmail could still quarantine a binary it can't scan. **Test once before go-live** (§5, step T).
- Resend's send-side blocklist [R-ATT] includes `.tmp`, `.reg`, `.url`, `.crt`, `.cer`, `.der` and `.exe`, among others. Gmail's includes `.img`, `.iso`, `.lib`, `.cab`, `.dmg` and `.sys`.
- **Naming rule:** `shwephala-YYYY-MM-DD.partNNofMM.gpg`, sent as MIME type `application/octet-stream`. Never use `.tmp`, `.img`, `.iso`, `.lib` or `.bin.gz`.
- **Do not wrap the gpg output in zip, 7z or tgz.** A password-protected or encrypted zip is exactly what Gmail blocks.
- Use binary gpg, not `--armor`. Armor adds about 33% before MIME base64 adds another 33%.

### 1.3 Size budget

Gmail send limit: "For personal Gmail accounts, the limit is 25 MB." [G-SIZE]. Google says encoding "adds about a 37% increase" (see cost-research E2).

15 MB raw ≈ 20.5 MB encoded, which fits under 25 MB. **The 15 MB raw part size stays correct for every option below except Mailjet** (15 MB total message size).

### 1.4 A compromised server can fill the backup mailbox

Any send credential lets an attacker on the server mail-bomb the backup mailbox:
- through Gmail: up to 500 mails/day × 25 MB
- through Resend: 100/day × 40 MB

A full mailbox (15 GB) **stops receiving** new mail [cost-research E7]. Old backups are not deleted, but new ones stop arriving.

No send-only credential prevents this. Mitigation: the owner watches the weekly "backup arrived" pattern, and a missed week is an alert in itself (§5). This risk is accepted.

---

## 2. Candidates

### 2.1 Resend Free, `onboarding@resend.dev`, Resend account opened with the backup Gmail address

| Item | Finding |
|---|---|
| Works without a domain? | Yes, but only to one address. "The `resend.dev` domain is only available for testing purposes and can only send emails to the email address associated with your Resend account." "You can only send testing emails to your own email address." [R-403] |
| "Testing only" wording | The official KB calls it a sandbox for "testing purposes". The AUP and ToS contain **no** clause that bans the testing domain, sending to yourself, attachments or encrypted content. The only termination wording found is general: "We reserve the right to terminate your account at any time for violation of the provisions of this section." and "If complaint or bounce rates go above these thresholds, your account may be shut down without warning." [R-AUP]. **Verdict: not prohibited, but outside the stated purpose.** Resend can restrict or remove it at any time with no notice obligation (ToS: free tier can change) [cost-research / compliance R2]. |
| Sender / DMARC | From is `onboarding@resend.dev`. resend.dev publishes `p=reject` and Resend signs it, so alignment is good. Inbox placement at the account owner's Gmail should be fine (unverified; test). The display name can be set (e.g. `ShwePhaLa Backup <onboarding@resend.dev>`). |
| Size | "Emails can be no larger than 40MB (including attachments after Base64 encoding)" [R-ATT]. No attachment restriction specific to the testing domain is documented [R-ATT]. Attachments can't use the batch endpoint. |
| Free limits | 100/day, 3,000/month. Test sends count. Bounce rate must stay under 4% and spam rate under 0.08% [R-Q]. |
| Card | No. |
| Business use | Allowed: the terms make no personal/commercial distinction (compliance doc). |
| API / SMTP | Both (HTTPS API recommended). |
| Credential scope | API key with `sending_access`, which "Can only send emails" [cost-research E16]. It can't read, list or delete anything. Domain restriction (`domain_id`) isn't possible for resend.dev, because it isn't a domain in the account. **Narrowest credential of all options.** |
| Retention | "Resend retains email data for 30 days across all plans" [R-Q]. Plaintext summaries sit at Resend for 30 days; encrypted parts are opaque. |
| Reliability / known issues | Single recipient only. The summary can't go to the owner's personal inbox directly; set a forwarding filter in the backup Gmail. If the app's existing Resend account uses a different login, this is a **second Resend account**; Resend's rules on multiple accounts per person were not checked (unverified). |
| Suspension risk | Low at a few mails/week with no bounces. The main risk is Resend locking down resend.dev further. |

### 2.2a Gmail SMTP with an app password, from a separate sender Gmail

| Item | Finding |
|---|---|
| Works without a domain? | Yes. |
| Sender / DMARC | `From: <sender>@gmail.com`, signed by Google, so DKIM is aligned. **Best possible inbox placement into Gmail.** |
| Size | 25 MB [G-SIZE]. |
| Limits | "more than 500 emails sent in a day" triggers "You have reached a limit for sending mail", recovering "within 1 to 24 hours" [G-LIM]. |
| Card | No. |
| Business use | Allowed (compliance doc §3). Program Policies forbid automation only "in a manner that misleads or deceives users" [G-PP]. Mailing yourself does not mislead anyone. |
| Credential scope | **Broad.** "An app password is a 16-digit passcode that gives a less secure app or device permission to access your Google Account." [G-AP] It works for SMTP, **IMAP and POP**: read, delete and send in the *sender* account. It does **not** allow web sign-in or account-settings changes (unverified; standard behaviour). What's exposed is only the sender's own mail: the Sent copies of encrypted parts, plus plaintext daily summaries. The server already holds that data. The backup mailbox is **not** exposed. |
| Google's stance | "App passwords aren't recommended and are unnecessary in most cases." "we revoke your app passwords when you change your Google Account password." Needs 2SV; unavailable with security-key-only 2SV or Advanced Protection [G-AP]. Long-term deprecation risk: already gone for Workspace "less secure apps". |
| Retention | Every sent message stays in the sender's **Sent** folder, which fills that account's 15 GB at the same rate as the backup mailbox. The server can prune Sent over IMAP with the same credential, or the owner prunes yearly. |
| Suspension risk | Low. A new account that immediately sends 20 MB binary attachments by SMTP can trip abuse heuristics. **Warm it up:** use it by hand for a week, then start with the daily summary (unverified heuristic). |

### 2.2b Gmail API with `gmail.send` OAuth scope, same separate sender Gmail

| Item | Finding |
|---|---|
| Send-only scope exists? | **Yes.** `https://www.googleapis.com/auth/gmail.send`: "Send email on your behalf." Classified **Sensitive** (not Restricted). By contrast, `https://mail.google.com/` is "Read, compose, send, and permanently delete all your email from Gmail." (Restricted) [G-SCOPES]. `messages.send` accepts `gmail.send` [G-SEND]. |
| SMTP with OAuth? | **No send-only option.** "The scope for IMAP, POP, and SMTP access is `https://mail.google.com/`." [G-XOAUTH]. So send-only means the **Gmail REST API**, not SMTP. |
| Free / verification | Personal use: "If the app is for your personal use (fewer than 100 users), you and your limited number of users can continue using the app without going through verification", with "users will be allowed to click through 'unverified app' warning screens" [G-EXC]. Cap: "100 new users in total" [G-UNV]. Only one user (the sender account) ever consents. A Cloud project plus the Gmail API need no billing account (unverified; no billing is requested for Gmail API quota). |
| 7-day trap | "A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of 'Testing' is issued a refresh token expiring in 7 days" [G-OAUTH]. **Fix: set the publishing status to "In production"** (it stays unverified and you click through the warning once). |
| Other token expiry | "The refresh token has not been used for six months." (weekly use prevents this). "The user changed passwords and the refresh token contains Gmail scopes." (re-mint after any password change). Revocation by the user [G-OAUTH]. |
| Sender / DMARC / size / limits | Same as 2.2a: aligned gmail.com, 25 MB per message (Gmail limit; the API's own upload cap wasn't stated on the fetched page), about 500/day. |
| Credential scope | The refresh token, client ID and client secret can **only send** as the sender account. They can't read, delete or change settings. **Narrowest Google option.** |
| Retention | API-sent mail is also kept in Sent (unverified; standard behaviour). The send-only token **can't prune it**, so the owner deletes old Sent mail by hand about yearly. At 1.5–3 GB/yr, 15 GB lasts at least 5 years. |
| Effort | Highest setup effort: a Cloud console project, a consent screen, and minting a token in a browser (§4.1). |

### 2.3 Brevo Free

- Free domains can't be authenticated. Brevo help (via search; direct fetch returned 403): domains of free email services "such as Gmail or Yahoo (e.g., @gmail.com or @yahoo.com) cannot be authenticated". If "sending from a free email address or have not authenticated your domain, Brevo temporarily replaces your sender address with a compliant one", e.g. `…@<id>.brevosend.com` [BR-FAQ][BR-CMP].
- So it **does work without a domain**, but under a rewritten, Brevo-owned sender that Brevo calls a "stopgap", not a permanent solution.
- Limits: 300/day. API attachments up to 25 MB total (cost-research E17/E18).
- Card: no.
- Verdict: **workable but brittle.** The sender may be rewritten unpredictably, and Brevo signals that it will tighten this.

### 2.4 Others (one line each)

| Provider | Verdict |
|---|---|
| **SMTP2GO Free** | **Unsuitable without a domain.** Verified senders mandatory since 2025-04-11, and single-sender verification "excludes Gmail, due to their DMARC record" [S2G-VS]. |
| **Mailjet Free** | 6,000/mo, 200/day, "no credit card required" [MJ-P]. But "The total email message size must not exceed 15MB" [MJ-SZ] (15 MB raw parts don't fit), and a gmail.com From fails DMARC. **Unsuitable.** |
| **MailerSend Free** | 500/mo, 1 domain, and a **card is required**: "we just ask that you provide this information to prevent abuse" [MS-P]. **Unsuitable** (card plus domain). |
| **SendGrid** | Free plan **retired**: "retiring its Free Email API … starting May 28, 2025". New accounts get a 60-day trial [SG]. **Unsuitable.** |
| **Postmark** | Needs domain/sender approval; the free developer tier is tiny (not re-verified). **Unsuitable.** |
| **Amazon SES** | AWS account needs a card; sandbox needs a verified identity (not re-verified). **Unsuitable.** |
| **Zoho Mail Forever Free** | Custom domain only, and IMAP/POP (and reportedly SMTP) unavailable on free [ZO]. **Unsuitable.** |
| **Proton / Fastmail** | SMTP submission and Bridge are paid-only (not re-verified). **Unsuitable.** |
| **Yahoo / AOL** | App passwords still exist: "App passwords … let non-Yahoo email apps access your account"; they survive main-password changes [YH]. Self-aligned DKIM (yahoo.com is `p=reject`, so Yahoo must sign). Sending limits and attachment size not found on official pages (unverified). Same full-mailbox credential problem as Gmail app passwords. Acceptable **tertiary** only. |
| **GMX / mail.com** | Free SMTP `mail.gmx.com:587`. POP3/IMAP access must be switched on and "will be turned off automatically … if you do not use POP3/IMAP for a longer period of time". 50 MB attachments [GMX]. gmx.net is `p=quarantine` and GMX signs its own mail. Unclear SMTP rate limits and English-language support. **Tertiary at best.** |

### 2.5 Direct SMTP from the home IP (no relay)

**Not viable.**
- Spamhaus PBL lists "end-user IP address ranges which should not be attempting to directly deliver unauthenticated SMTP email to any Internet mail server" [SH-PBL].
- Gmail requires SPF or DKIM "for your sending domains" and a valid PTR for the sending IP [G-SR]. Without a domain there is nothing to publish SPF or DKIM in, and a residential PTR is ISP-controlled.
- Many ISPs also block outbound port 25 (not verified for the shop's ISP).
- Expect rejection or spam-foldering.

### 2.6 Non-email alternative (one paragraph)

**Google Drive via rclone** is the strongest $0 non-email channel: 15 GB, no card, no size splitting, no 25 MB limit.
- Use your own OAuth client: "This shared client_id is being retired and will stop working during 2026" [RC].
- Use scope `drive.file`: "Access to files created by rclone only." [RC]. That token can't see the rest of the Drive, but it **can delete what it uploaded**. So a compromised server could wipe the backups, which emailed copies in a separate mailbox avoid.
- The same "In production" publishing-status rule (§2.2b) applies, to avoid 7-day refresh-token expiry.
- Worth keeping as a later **second copy**. Not a replacement, since the owner chose email for its append-only property.

---

## 3. Comparison

| Option | No domain? | Sender / alignment | Max msg (encoded) | Free limit | Card | Business OK | Interface | Credential on server can… | Provider retention | Main risk |
|---|---|---|---|---|---|---|---|---|---|---|
| **Gmail API `gmail.send`** (separate sender Gmail) | Yes | sender@gmail.com, aligned | 25 MB | ~500/day | No | Yes | HTTPS API | **send only** | Sent folder (owner prunes) | OAuth setup effort; token revoked on password change |
| **Gmail SMTP app password** (separate sender Gmail) | Yes | sender@gmail.com, aligned | 25 MB | ~500/day | No | Yes | SMTP 587 | send + read/delete **sender** mailbox | Sent folder | Google discourages app passwords; possible future removal |
| **Resend `onboarding@resend.dev`** | Yes (owner address only) | resend.dev, aligned (`p=reject`) | 40 MB | 100/day, 3,000/mo | No | Yes | HTTPS API / SMTP | **send only** | 30 days at Resend | "Testing purposes" wording; can be withdrawn |
| Brevo Free | Rewritten sender | brevosend.com stopgap | 25 MB | 300/day | No | Yes | API / SMTP | send (+ account API) | not checked | Sender rewrite is a stopgap |
| Yahoo / GMX app password | Yes | own domain, aligned | GMX 50 MB; Yahoo unknown | unknown | No | not checked | SMTP | full sender mailbox | mailbox | Undocumented limits; GMX auto-disables IMAP/POP |
| SMTP2GO / Mailjet / MailerSend / SendGrid / SES / Zoho / Proton / Fastmail / Postmark | No | — | — | — | — | — | — | — | — | Domain, card or paid |
| Direct from home IP | — | fails PTR/SPF | — | — | — | — | — | — | — | PBL / port 25 |

---

## 4. Recommendation

**Primary: Gmail API with the `gmail.send` scope, from a new, dedicated sender Gmail account, sending to the backup Gmail.**
- It is the only option that combines a send-only credential, a DMARC-aligned sender with first-class Gmail-to-Gmail deliverability, no "testing-only" wording, and $0 with no card.
- Google explicitly allows personal-use unverified apps.
- Cost: a one-time console setup, plus re-minting the token after any password change on the sender account.

**Fallback: Gmail SMTP with an app password on the same sender account.** *(Rejected by the owner on 2026-10-13: no Gmail app passwords; see §5.2.)*
- Use it if the OAuth setup is too much for the owner, or while a token is being re-minted.
- It's simpler (a standard SMTP client such as `msmtp`). The credential reaches only the sender mailbox, which holds only copies of what the server already has.
- Accept Google's "not recommended" stance and possible future deprecation.

**Emergency / independent fallback: Resend `onboarding@resend.dev`**, with the Resend account opened under the backup Gmail address.
- Use it only if the sender Gmail is locked. It's a different failure domain (Resend plus Amazon SES), and its key is also send-only.
- Not as the long-term primary: Resend documents resend.dev as "only available for testing purposes".

**Not recommended without a domain:** Brevo (rewritten sender), SMTP2GO, Mailjet, MailerSend, SendGrid, SES, Zoho, Proton, Fastmail, and direct SMTP.

**Rules for all options:**
- **Never** place any credential for the *backup* Gmail on the server.
- Keep plaintext summaries to aggregates only, because they persist in the sender's Sent folder (and for 30 days at Resend in the fallback).

---

## 5. Owner setup steps

The engineer never sees the values. The owner types them; the engineer checks only file metadata (`stat -c '%U:%G %a %s' <file>`), never contents. Per the user rule, never `cat`, `grep` or `head` these files.

### 5.0 Accounts (both options)

1. **Backup Gmail.** Create it if it doesn't exist. Turn on 2SV (Google Prompt or an authenticator app, plus printed backup codes stored offline). **Never** create an app password, OAuth client or Resend key for it.
2. **Sender Gmail.** Create a new account, e.g. `shwephala.backup.sender@gmail.com`:
   - Turn on 2SV, with **not** security-key-only and **not** Advanced Protection (both block app passwords).
   - Set a recovery phone and email (the owner's).
   - Sign in by hand a few times over about a week before automation starts (warm-up).
3. **Backup Gmail filter.** Add one in the backup Gmail: `from:(shwephala.backup.sender@gmail.com)` → Never send to Spam, apply label `backups`. Optionally forward `subject:(daily summary)` to the owner's personal inbox.

### 5.1 Primary: Gmail API with the `gmail.send` scope

> **Superseded 2026-10-13 by the implementation.** The transport is built (`MAIL_TRANSPORT=gmail-api`
> in `email-lib.sh`) together with a stdlib-only mint helper (`deploy/lucashome/backup/gmail-oauth-mint.py`,
> no `google-auth-oauthlib`). The authoritative owner steps, paths and file modes are in
> [email-backup-design.md §10](email-backup-design.md#10-owner-approval-enablement-checklist-gmail-api):
> the credential lives at `/srv/supabase/backup/credentials/gmail-oauth.json`, mode **0600, owned by the
> backup (SSH) user** (the jobs refuse anything else), not under `/etc/shwephala`. The steps below are
> kept as research notes only.

**Create the OAuth client.** Signed in as the **sender** Gmail at console.cloud.google.com:

1. Create a project `shwephala-mail`. Decline any billing prompt; none is needed.
2. Go to APIs & Services → Library → **Gmail API** → Enable.
3. Go to Google Auth Platform / OAuth consent screen:
   - User type **External**, app name `ShwePhaLa backup`, support email = the sender address.
   - Under Data access → Add scope, add **only** `https://www.googleapis.com/auth/gmail.send`.
   - Under Audience, add the sender address as a test user, then click **Publish app → In production**. This avoids the 7-day refresh-token expiry.
   - Don't submit for verification.
4. Go to Clients → Create client → type **Desktop app** → Download JSON (`client_secret_….json`).

**Mint the refresh token.** Do this on the owner's own laptop, which has a browser:

5. Run the small token-mint script the engineer provides (Google's `google-auth-oauthlib` `InstalledAppFlow.run_local_server`, scope `gmail.send` only) against the downloaded JSON.
6. Sign in as the **sender** Gmail. At "Google hasn't verified this app", click Advanced → Go to ShwePhaLa backup (unsafe) → Allow.
7. The script writes `gmail-token.json`, containing `client_id`, `client_secret` and `refresh_token`.

**Install it on the server.**

8. Copy the file to the server, then delete both local files:
   ```
   scp gmail-token.json <server>:/tmp/gt
   rm -P gmail-token.json client_secret_*.json
   ```
9. On the server, as the owner:
   ```
   sudo install -d -m 0750 -o root -g shwephala-backup /etc/shwephala/secrets
   sudo install -m 0640 -o root -g shwephala-backup /tmp/gt /etc/shwephala/secrets/gmail-oauth.json
   shred -u /tmp/gt
   ```
   Only the backup service user's group can read the file, and it can't write to it.
10. Non-secret config, at `/etc/shwephala/mail.env`, mode 0644:
    - `MAIL_FROM=shwephala.backup.sender@gmail.com`
    - `MAIL_TO=<backup>@gmail.com`
    - `MAIL_TRANSPORT=gmail-api`
11. **Re-mint** (steps 5–9) after any password change on the sender account, or if the token goes unused for 6 months.

### 5.2 Fallback: Gmail SMTP with an app password

> **Not allowed (owner decision, 2026-10-13): Gmail app passwords are never used.** Kept as research
> notes only. Alternatives that are implemented: Resend (`MAIL_TRANSPORT=resend`) and a send-only
> SMTP relay credential (`MAIL_TRANSPORT=smtp`).

1. Signed in as the **sender** Gmail: myaccount.google.com → Security → 2-Step Verification → **App passwords** → name `shwephala-server` → copy the 16 characters. Don't paste them anywhere else.
2. On the server, as the owner. The value is typed, never echoed, and never in shell history:
   ```
   sudo install -d -m 0750 -o root -g shwephala-backup /etc/shwephala/secrets
   sudo bash -c 'umask 027; read -rs -p "Sender app password: " v; echo; printf %s "$v" > /etc/shwephala/secrets/gmail-app-password; chgrp shwephala-backup /etc/shwephala/secrets/gmail-app-password; chmod 0640 /etc/shwephala/secrets/gmail-app-password'
   ```
3. The mailer config (e.g. `msmtp`) uses `host smtp.gmail.com`, `port 587`, `tls on`, `auth on`, the sender address as `user`, and `passwordeval "cat /etc/shwephala/secrets/gmail-app-password"`. The config file is mode 0640, same owner/group as the secret.
4. To revoke: delete the app password in the same Google page. It is also revoked automatically when the sender's password changes [G-AP].

### 5.3 Emergency: Resend `onboarding@resend.dev`

1. Sign up at resend.com **with the backup Gmail address** (email/password login, 2FA on). No domain, no card.
2. Go to API Keys → Create → permission **Sending access** → copy the key once.
3. Store it as in §5.2 step 2, at `/etc/shwephala/secrets/resend-api-key`, mode 0640, `root:shwephala-backup`.
4. Use `from: "ShwePhaLa Backup <onboarding@resend.dev>"` and `to:` the backup Gmail. Anything else returns 403.

### Step T: go-live test (owner and engineer, once)

1. Send a test part named `test.part01of01.gpg` (about 15 MB raw, random data, gpg-encrypted) through the chosen path.
2. In the backup Gmail, check that it landed in the Inbox (not Spam) and that the attachment downloads without a "blocked" or "couldn't scan" banner.
3. Check that the SHA-256 matches and that it decrypts.
4. Repeat with an 8.5 MB single-part file. Record the result in the ops log.

### Ongoing

- The owner signs into **both** Gmail accounts at least yearly. Inactivity deletion happens after 2 years; "Reading or sending an email" counts as activity [G-INACT]. Whether API-only sending counts is unverified.
- Prune old weeks in the backup mailbox and old Sent mail in the sender account before either nears 15 GB.
- A missing weekly email means the job failed or the mailbox is full. Investigate either way.

---

## Sources (all retrieved 2026-10-13)

- G-SR https://support.google.com/a/answer/81126 (email sender guidelines)
- G-BLK https://support.google.com/mail/answer/6590 (blocked file types)
- G-SIZE https://support.google.com/mail/answer/6584
- G-LIM https://support.google.com/mail/answer/22839
- G-PP https://support.google.com/mail/answer/16734397 (Gmail Program Policies)
- G-AP https://support.google.com/accounts/answer/185833 (app passwords)
- G-SCOPES https://developers.google.com/workspace/gmail/api/auth/scopes
- G-SEND https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- G-XOAUTH https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
- G-OAUTH https://developers.google.com/identity/protocols/oauth2 (refresh token expiration)
- G-EXC https://support.google.com/cloud/answer/13464323 (verification exceptions)
- G-UNV https://support.google.com/cloud/answer/7454865 (unverified apps)
- G-INACT https://support.google.com/accounts/answer/12418290
- DNS: `dig +short TXT _dmarc.gmail.com` etc., run 2026-10-13
- R-403 https://resend.com/docs/knowledge-base/403-error-resend-dev-domain
- R-Q https://resend.com/docs/knowledge-base/account-quotas-and-limits
- R-ATT https://resend.com/docs/dashboard/emails/attachments ; https://resend.com/docs/knowledge-base/what-attachment-types-are-not-supported
- R-AUP https://resend.com/legal/acceptable-use
- BR-FAQ https://help.brevo.com/hc/en-us/articles/17286219877778 ; BR-CMP https://help.brevo.com/hc/en-us/articles/14925263522578 (both 403 to direct fetch; quoted from search-indexed text, so **partly verified**)
- S2G-VS https://www.smtp2go.com/blog/registering-a-verified-sender-is-now-a-required-action/
- MJ-P https://www.mailjet.com/pricing/ ; MJ-SZ https://documentation.mailjet.com/hc/en-us/articles/360043179773 (via search snippet)
- MS-P https://www.mailersend.com/pricing
- SG https://www.twilio.com/en-us/changelog/sendgrid-free-plan ; https://support.sendgrid.com/hc/en-us/articles/35270136965403
- ZO https://www.zoho.com/mail/zohomail-pricing.html ; https://help.zoho.com/portal/en/community/topic/no-more-imap-pop-smtp-on-free-plans-even-on-referrals-with-no-notice (community; partly verified)
- YH https://help.yahoo.com/kb/SLN15241.html (via search snippet)
- GMX https://support.gmx.com/pop-imap/toggle.html ; https://www.gmx.com/mail/attachment/ (via search snippet)
- SH-PBL https://www.spamhaus.org/blocklists/policy-blocklist/
- RC https://rclone.org/drive/
