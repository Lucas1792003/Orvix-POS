# Phase F: $0 cost research (email backups, hosting, signing)

Retrieved 2026-10-13 unless noted. Research only: no sign-ups, no billing pages submitted.
Owner constraint: $0 additional recurring cost. No free tier is assumed permanent. Anything that needs a payment card is flagged **[CARD]**, even when usage is free.

Owner scope decisions:
- Offsite backups are **email-based**.
- The owner's Mac is **not** a backup target.
- Object storage is out of scope.

Legend: **Verified** = stated on the cited official vendor page. **Unverified** = from third-party sources, or not stated on the official page. Test these before relying on them.

---

## 0. Object storage (dropped by owner; one line each, for the record)

- **Cloudflare R2**: 10 GB free, but enabling R2 likely **[CARD]**. Overage is billed with no cap. Tokens can't separate write from delete; bucket locks exist. [S1][S2][S3]
- **Backblaze B2**: 10 GB free, no card to sign up (third-party sources). The writer key can omit `deleteFiles`. Caps give a hard 403 stop. Whether Object Lock works on a no-card account is unverified. [S4][S5][S6]
- **Google Drive via rclone**: 15 GB, no card. Trash lasts 30 days. The token can permanently delete, so there is no ransomware protection. [S7]
- **Storj**: the free tier ended 2025-07-01; it is now a 30-day trial, then a $5/month minimum. [S8] **Oracle Cloud** requires a card (not re-verified). **Hetzner** has no free tier.

---

## 1. Email delivery at $0 (main section)

### (a) Consumer Gmail (gmail.com)

| Item | Finding | Status |
|---|---|---|
| Send attachment limit | "For personal Gmail accounts, the limit is 25 MB." Larger attachments get converted to Drive links in the web UI; over SMTP the send is rejected. | Verified [E1] |
| Receive limit | Workspace accounts receive up to 50 MB. Google counts that limit *after* encoding, which "adds about a 37% increase". For personal accounts the help page found here gives only the 25 MB send figure. **Treat 25 MB encoded as the safe receiving ceiling.** | Workspace figure verified [E2]; personal receive limit **unverified** |
| Daily sending limit | Personal accounts: about 500 emails/day and 500 recipients per message. If exceeded, sending is blocked for 1–24 hours. | Verified [E3] |
| SMTP authentication | Since **2025-03-14** "less secure apps" password logins are off for all Google accounts. SMTP, IMAP and POP need OAuth or an **app password**. | Verified [E4][E5] |
| App passwords | Still available in 2026. They need 2-Step Verification and are unavailable with security-key-only 2SV, Advanced Protection or work accounts. Google: "aren't recommended and are unnecessary in most cases." | Verified [E6] |
| What an app password grants | It "gives a less secure app or device permission to access your Google Account". Since January 2025 **IMAP is always on** for Gmail. So an app password held on the server for SMTP **also gives full IMAP mailbox access**, including deleting old backup mails. **Never put the backup-receiving mailbox's credentials on the server.** | Verified [E5][E6] |
| Storage | 15 GB shared across Gmail, Drive and Photos. A full account **can't send or receive**. | Verified [E7] |
| Inactivity | The account is deleted after 2 years of inactivity, with warnings emailed first. | Verified [E8] |
| Card | None. | — |

### (b) Outlook.com / Hotmail (consumer)

| Item | Finding | Status |
|---|---|---|
| SMTP auth | "Outlook.com requires the use of Modern Auth / OAuth2." Microsoft Q&A answers say consumer Outlook.com accounts no longer accept basic-auth SMTP, and that SMTP AUTH basic auth for Exchange Online was phased out from 2026-03-01 to 2026-04-30. **Plain username/app-password SMTP from a server is not a dependable path in 2026.** | OAuth requirement verified [E9]; retirement details from Microsoft Q&A [E10] |
| Attachment limit | 25 MB on Outlook.com. Desktop Outlook caps internet accounts at 20 MB total. | Verified [E11] |
| Verdict | Avoid it as the sender: it needs OAuth2 plumbing. Fine as a *recipient*. | — |

### (c) Resend free plan (already used by the app)

| Item | Finding | Status |
|---|---|---|
| Quota | **100 emails/day, 3,000/month**. Sent *and received* emails both count, and each To/CC/BCC recipient counts separately. 10 requests/second. | Verified [E12][E13] |
| Overage | Nothing is billed: "you will be notified and given the option to upgrade". Sending stops until you upgrade or the quota resets. | Verified [E13] |
| Card | None for Free. | Verified (implied by free plan) [E13] |
| Size limit | "Emails can be no larger than **40MB** (including attachments after Base64 encoding)", so about **29 MB raw**. The batch endpoint doesn't support attachments, and some file types are blocked. | Verified [E14] |
| No verified domain | `onboarding@resend.dev` can only send "to your own email address" (the account owner's). Other recipients return 403. A verified domain is needed for anything else. The Free plan includes custom domains, listed as 3 on the current pricing page. | Verified [E13][E15] |
| Least privilege | API key permission `sending_access` means "Can only send emails" and can be **restricted to one domain** (`domain_id`). The key cannot read, list or delete anything. | Verified [E16] |
| Retention | The Free plan keeps "email content and metadata" for **30 days**. Plaintext daily summaries therefore sit at Resend for 30 days; encrypted archives are opaque to Resend. | Verified [E12] |

### (d) Other card-free transactional providers (short)

| Provider | Free limits | Attachment / size | Card / domain | Status |
|---|---|---|---|---|
| **Brevo** | 300/day (about 9k/month), forever free | API: 25 MB per email. Template transactional mail: 20 MB total, attachments under 4 MB. | Brevo's marketing pages say no card is needed (the pricing-page fetch was ambiguous). Sender/domain verification is needed. | Partly verified [E17][E18] |
| **SMTP2GO** | 1,000/month, 200/day, no time limit | **50 MB** per email (SMTP and API) | Verified sender domain or address required; until then a 25/hour cap applies. Up to 5 senders on Free. | Verified [E19] |
| **Mailjet** | 6,000/month, 200/day | Size limit not found | Mailjet published a "Changes to our Free Plan" notice that could not be fetched. Re-check before use. | Partly verified [E20] |

None of these beats Resend for this app, which already has Resend integrated and a domain set up. SMTP2GO is the best **fallback** because of its 50 MB size limit.

### (e) Splitting archives across emails

- No reviewed provider forbids sending one archive split over several emails. Resend, Gmail and SMTP2GO limit size per message and messages per day, not content. Sending to your own mailbox is low-volume and isn't bulk mail.
- Base64 adds about 33% (Google says "about 37%" including MIME overhead [E2]). The binding limit is the **receiving mailbox**: Gmail and Outlook.com are effectively 25 MB encoded.
- **Recommended ceiling: 15 MB raw per part** (about 20.5 MB encoded). That leaves headroom under 25 MB for headers and the body. An 18 MB raw part (about 24.6 MB encoded) is the absolute maximum and gives no margin.
- Mechanics:
  1. Encrypt first (`age` or `gpg`), then split (`split -b 15m`).
  2. Name parts `shwephala-YYYY-MM-DD.partNN-of-MM` and include a SHA-256 manifest in the body.
  3. Send each part as its own email. Weekly volume today is 1–2 emails, well within 100/day.
  4. Restore by concatenating, checking the SHA-256 and decrypting.
- Gmail's 15 GB fills at roughly 1.5 GB/yr today (30 MB × 52), so it lasts many years. The owner prunes old weeks by hand in the Gmail UI.

---

## 2. Tailscale Personal (free)

| Item | Finding | Status |
|---|---|---|
| Limits | Up to **6 users** (raised from 3 on 2026-04-08, when Personal Plus was retired). Unlimited user devices. 50 tagged resources included, **then $1/month each**. 1,000 ephemeral minutes per month. 3 ACL groups. 5 SSH hosts. Funnel included. | Verified [T1][T2] |
| Card | None ("Free forever"). | Verified [T1] |
| `tailscale serve` + HTTPS | Serve requires the tailnet's HTTPS certificates (Let's Encrypt; rate limits apply). The docs don't gate it by plan. **Machine names appear in public CT logs.** | Verified [T3][T4] |
| **Commercial use** | "This is a free plan and is only suitable for **non-commercial use** of Tailscale." The next tier is Standard at $8/user/month. | Verified [T1] |

## 3. Vercel Hobby

| Item | Finding | Status |
|---|---|---|
| Free | Yes. There is no billing; exceeding a limit pauses the feature for up to 30 days. | Verified [V1] |
| **Commercial use** | "Hobby teams are restricted to non-commercial personal use only." Commercial means financial gain for anyone involved, including "any method of requesting or processing payment". **A shop POS is commercial, so Hobby is not permitted.** Pro costs $20/user/month. | Verified [V2] |
| `git.deploymentEnabled` | `false` turns off automatic deployments for **all branches, production and preview alike**. The object form works per branch (minimatch syntax), and any matching `true` rule wins. Manual, CLI and deploy-hook deployments still work. `github.enabled` is deprecated. | Verified [V3] |
| Dashboard | There is no on/off toggle. Use **Project → Settings → Build and Deployment → Ignored Build Step → "Don't build anything"**. Cancelled builds still count toward quotas. | Verified [V4] |
| Disconnect | **Project → Settings → Git → Connected Git Repository → Disconnect.** | Verified [V5] |

## 4. GitHub Free (public repository)

| Item | Finding | Status |
|---|---|---|
| Actions | **Free** for public repos on standard hosted runners, and free on self-hosted runners. Private repos get 2,000 minutes per month; with no card on file, usage is blocked at the quota. The planned $0.002/min self-hosted charge was **postponed**, and public repos were exempt from it anyway. | Verified [G1][G2] |
| Releases | 1,000 assets per release, 2 GiB per file, **no total-size or bandwidth limit**. An electron-updater check uses up to 3 API requests. | Verified [G3][C3] |
| Pages | Free for public repos. 1 GB site, 100 GB/month soft bandwidth limit. Prohibits "commercial transactions or … SaaS". | Verified [G4] |

## 5. Code signing at $0

| Item | Finding | Status |
|---|---|---|
| Windows, unsigned | "Strong SmartScreen block; enterprises may block entirely." Self-signed certificates behave the same unless installed as a trusted root on each till. Since 2024, EV certificates no longer bypass SmartScreen. | Verified [C1] |
| Windows, electron-updater unsigned | electron-updater can validate Windows signatures. Unsigned NSIS updates are commonly reported to work when no `publisherName` is set. App-downloaded updates usually avoid SmartScreen. **Test on a till.** | Partly verified [C3] |
| Microsoft Store (MSIX) | **Free**: Microsoft re-signs the package and there are no SmartScreen warnings. Updates then come through the Store, not GitHub. | Verified [C1] |
| SignPath Foundation | Free if the whole project uses an OSI license with **no commercial dual-licensing and no proprietary components**, is actively maintained and released, has defined Author/Reviewer/Approver roles and MFA, and publishes a code-signing policy. | Verified [C4] |
| Azure Artifact Signing | **$9.99/month** **[CARD]** on a paid Azure subscription. Individuals: **US and Canada only**. No instant SmartScreen trust. | Verified [C1][C5] |
| macOS without the $99/yr program | Gatekeeper blocks the app until each user clicks **System Settings → Privacy & Security → Open Anyway** once [C6]. **Auto-update does not work**: "Your application must be signed for automatic updates on macOS. This is a requirement of Squirrel.Mac" [C2]; electron-builder says the same [C3]. | Verified |

## 6. Supabase hosted Free plan

- Two free projects; paused projects don't count toward the limit [U1].
- A project **pauses after low activity over 7 days**, with two warning emails first [U2].
- Restore window: **1 year** per the current docs [U2]; the 2024 changelog said 90 days [U3]. **Plan for 90 days.**
- So the frozen hosted fallback will pause within about a week of cutover. Treat it as a cold archive and rely on the emailed weekly archive.

---

## Recommendation (email)

The key security idea: **the server holds a send-only credential, and the mailbox that stores backups never has a credential on the server.** A compromised or ransomwared server can then send junk mail, but it cannot delete past backups.

1. **Daily plaintext business-summary report → Resend**, from the app's existing verified domain.
   - Use a **new API key with `sending_access`, restricted to that domain**.
   - It uses 1 of 100 emails/day. No card needed, and overage is a hard stop, not a bill.
   - Caveat: the plaintext sits in Resend's logs for 30 days. Keep the summary to aggregates (totals, counts) with no customer PII.
2. **Weekly encrypted recovery archive → Resend, with the same send-only key**:
   - Recipient: a **dedicated, free Gmail account** used only to receive backups. No card. 2SV on. No app password ever created. Its credentials never go on the server.
   - Encrypt with `age` before upload, split into **15 MB raw parts** (about 20.5 MB encoded, under Gmail's 25 MB and Resend's 40 MB), and send a SHA-256 manifest.
   - Optionally CC a second family member's mailbox for a second copy. Each recipient counts toward the Resend quota, which is still far below the limit.
   - Fallback sender if Resend changes its free tier: **SMTP2GO Free** (50 MB per message, 200/day, no card, verified domain required).
   - **Do not** send through Gmail SMTP with an app password. That credential also opens the mailbox over IMAP and could delete the archive.
   - **Do not** use Outlook.com SMTP; it requires OAuth2 in 2026.
3. Monthly restore test: download the parts, concatenate, verify the hash, decrypt and run `pg_restore` into scratch.
4. The owner logs into the backup Gmail account at least yearly (2-year inactivity deletion) and prunes old weeks before the account nears 15 GB.

## Unavoidable or likely costs

| Item | Type | Cost | Avoidable? |
|---|---|---|---|
| Email backups (Resend Free + Gmail) | — | $0, no card | Yes. Risks: Resend cuts its free tier (fall back to SMTP2GO or Brevo), or the archive outgrows the 15 GB mailbox after many years. |
| **Vercel**: Hobby forbids commercial use | Recurring | Pro at $20/user/month **[CARD]** | Yes. Stop Vercel deploys for the POS web build (disconnect or `deploymentEnabled: false`). GitHub Pages is not a substitute because it also prohibits commercial transactions. |
| **Tailscale**: Personal is "only suitable for non-commercial use" | Recurring | Standard at $8/user/month **[CARD]** | Owner's call on terms risk; the technical limits are fine. |
| Tailscale tagged resources over 50 | Recurring | $1/month each | Yes. Stay at 50 or fewer. |
| **macOS signing** (Apple Developer Program) | Recurring | $99/yr **[CARD]** | Yes, but Mac tills then get **no auto-update** (manual DMG per release, plus a one-time "Open Anyway"). |
| **Windows signing** | Recurring | $9.99/month Azure (individuals only in US/CA), or an OV certificate at $150–300/yr | Yes. Ship unsigned (SmartScreen warning on first install), or use SignPath (only if fully OSI-licensed) or the Microsoft Store via MSIX. |
| Domain renewal for the Resend sender domain (if not already paid) | Recurring | Typically about $10–15/yr | Already sunk if the app's current Resend domain is kept. |
| Supabase keeping the fallback warm | Recurring | Pro plan | Yes. Accept pausing. |
| One-time costs | One-time | None required | — |

## Sources (all retrieved 2026-10-13)

- S1 https://developers.cloudflare.com/r2/pricing/ · S2 https://developers.cloudflare.com/r2/api/tokens/ · S3 https://developers.cloudflare.com/r2/buckets/bucket-locks/
- S4 https://www.backblaze.com/cloud-storage/pricing · S5 https://www.backblaze.com/docs/cloud-storage-application-key-capabilities · S6 https://www.backblaze.com/docs/cloud-storage-data-caps-and-alerts
- S7 https://rclone.org/drive/ · S8 https://www.storj.io/pricing
- E1 https://support.google.com/mail/answer/6584
- E2 https://support.google.com/a/answer/1366776 (Workspace receiving limits, encoding note)
- E3 https://support.google.com/mail/answer/22839
- E4 https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth ; https://workspaceupdates.googleblog.com/2023/09/winding-down-google-sync-and-less-secure-apps-support.html
- E5 https://support.google.com/mail/answer/7126229
- E6 https://support.google.com/accounts/answer/185833
- E7 https://support.google.com/mail/answer/6374270
- E8 https://support.google.com/accounts/answer/12418290
- E9 https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040
- E10 https://learn.microsoft.com/en-us/answers/questions/4734492/will-app-password-with-smtp-auth-still-work-after ; https://learn.microsoft.com/en-us/answers/questions/5816949/outlook-account-created-on-2026-with-microsoft-365 (Microsoft Q&A, community answers)
- E11 https://support.microsoft.com/en-us/office/reduce-attachment-size-to-send-large-files-with-outlook-8c698842-b462-4a4c-8d53-5c5dd04f77ef
- E12 https://resend.com/docs/knowledge-base/account-quotas-and-limits
- E13 https://resend.com/pricing
- E14 https://resend.com/docs/dashboard/emails/attachments
- E15 https://resend.com/docs/knowledge-base/403-error-resend-dev-domain
- E16 https://resend.com/docs/api-reference/api-keys/create-api-key
- E17 https://www.brevo.com/free-smtp-server/ ; https://www.brevo.com/pricing/
- E18 https://help.brevo.com/hc/en-us/articles/4402811730962-Add-an-attachment-to-a-transactional-email
- E19 https://support.smtp2go.com/hc/en-gb/articles/223087947-Free-Plan ; https://www.smtp2go.com/pricing/
- E20 https://documentation.mailjet.com/hc/en-us/articles/360043048393-What-is-this-200-emails-per-day-limit-on-free-accounts ; https://documentation.mailjet.com/hc/en-us/articles/19154256993051-Changes-to-Our-Free-Plan (403 on fetch)
- T1 https://tailscale.com/pricing · T2 https://tailscale.com/blog/pricing-v4 · T3 https://tailscale.com/kb/1312/serve · T4 https://tailscale.com/kb/1153/enabling-https
- V1 https://vercel.com/docs/plans/hobby · V2 https://vercel.com/docs/limits/fair-use-guidelines · V3 https://vercel.com/docs/project-configuration/git-configuration · V4 https://vercel.com/docs/project-configuration/project-settings · V5 https://vercel.com/docs/project-configuration/git-settings
- G1 https://docs.github.com/en/billing/concepts/product-billing/github-actions · G2 https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/ · G3 https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases · G4 https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- C1 https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options · C2 https://www.electronjs.org/docs/latest/api/auto-updater · C3 https://www.electron.build/docs/features/auto-update · C4 https://signpath.org/terms · C5 https://azure.microsoft.com/en-us/pricing/details/artifact-signing/ · C6 https://support.apple.com/en-us/102445
- U1 https://supabase.com/docs/guides/platform/billing-on-supabase · U2 https://supabase.com/docs/guides/platform/free-project-pausing · U3 https://supabase.com/changelog/27497-paused-free-plan-projects-are-restorable-for-90-days
