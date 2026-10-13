# lucashome — orphan storage objects inventory

Recorded **2026-10-13** (owner decision: preserve all 17; do not delete, rename or move). Read-only SQL on `storage.objects` joined to `products.image_url`, `business_profile.logo_url` and `product_image_upload_sessions` (path / public_url); original creation dates and SHA-256 from the hosted export metadata (`~/shwephala-migration/20261011T2347Z/storage-objects.json`, `storage-manifest.sha256`) because `storage.objects.created_at` on lucashome is the 2026-10-12 re-upload time. Contents not inspected.

Context: 42 of the 574 migrated objects are not shown by any product or logo; 25 of those are still linked to an upload-session row (078 maps them to their org, so the real org can manage them). The 17 below map to no product, logo or session, so under 078 only `service_role` can manage them. Public URLs still resolve.

| # | Object path | Size (bytes) | Type | Originally created (hosted) | Age (days) | Referenced by | SHA-256 (prefix) |
|---|---|---|---|---|---|---|---|
| 1 | `products/prod-1779555606176/1779555610680.webp` | 9370 | image/webp | 2026-05-23 | 143 | product row deleted (path names a missing product) | `639f8b74e2ce` |
| 2 | `temp/pimg-068a110a82764785a9280806399ecaff` | 6646 | image/webp | 2026-06-09 | 126 | nothing (no product, logo or upload session) | `adc2daba7e21` |
| 3 | `temp/pimg-0b43178632b24426b4156c5ad403a4dc` | 7198 | image/webp | 2026-06-09 | 126 | nothing (no product, logo or upload session) | `5043ac8f1442` |
| 4 | `temp/pimg-0ce11dd75b1b45b893cd0a311f838fff` | 35425 | image/jpeg | 2026-06-08 | 127 | nothing (no product, logo or upload session) | `c71202429ed9` |
| 5 | `temp/pimg-29416cba588d46c9a5419068574e4b89` | 8392 | image/webp | 2026-06-09 | 126 | nothing (no product, logo or upload session) | `8fa113234f6a` |
| 6 | `temp/pimg-4f4878e90fa54727be65fcd58315f4c1` | 10438 | image/webp | 2026-06-09 | 126 | nothing (no product, logo or upload session) | `673963cc976e` |
| 7 | `temp/pimg-631333f938d247e28e267ea32908c284` | 14346 | image/jpeg | 2026-05-23 | 143 | nothing (no product, logo or upload session) | `993c9ff3584b` |
| 8 | `temp/pimg-69279a281639460782a9938adde90d06` | 28527 | image/jpeg | 2026-05-25 | 141 | nothing (no product, logo or upload session) | `2fdb45d797d3` |
| 9 | `temp/pimg-6fd7bacf77374d3abe76bcd0f85f3026` | 17352 | image/webp | 2026-06-09 | 126 | nothing (no product, logo or upload session) | `70aed9e86353` |
| 10 | `temp/pimg-7a855c4448034ef5b195baa71a7f952f` | 13712 | image/webp | 2026-06-09 | 126 | nothing (no product, logo or upload session) | `ef88e6335d46` |
| 11 | `temp/pimg-7e87ab018a404426ad6ce4c0177ad98e` | 20588 | image/jpeg | 2026-05-23 | 143 | nothing (no product, logo or upload session) | `39e6d7eed0d0` |
| 12 | `temp/pimg-acc9280f5a354f1fbbf4f506366fcb0a` | 26431 | image/jpeg | 2026-05-24 | 142 | nothing (no product, logo or upload session) | `86a1c1803e3e` |
| 13 | `temp/pimg-cf43238be3374c069f5ceeeeac595e79` | 36220 | image/jpeg | 2026-06-08 | 127 | nothing (no product, logo or upload session) | `7e8b4755e591` |
| 14 | `temp/pimg-d750cd729ed6458198e46ccf27b888be` | 31301 | image/jpeg | 2026-05-25 | 141 | nothing (no product, logo or upload session) | `d78a2d10183f` |
| 15 | `temp/pimg-daf65f7cc224488f9a23634867cbd49a` | 31690 | image/jpeg | 2026-05-25 | 141 | nothing (no product, logo or upload session) | `20d8057c7a15` |
| 16 | `temp/pimg-f74b604e9df84b4094ecc4782d82b4a6` | 40735 | image/jpeg | 2026-06-08 | 127 | nothing (no product, logo or upload session) | `e1af8b5d6d2b` |
| 17 | `temp/pimg-fc7f8f440da14e899944d861ae57b733` | 30350 | image/jpeg | 2026-05-25 | 141 | nothing (no product, logo or upload session) | `6c8f526be752` |

Total: 17 objects, 368721 bytes.

Re-verify: `storage.objects` rows for these names must stay byte-identical (name, size, version) after any test run; the QA cleanup never deletes outside `qa-` / `org/qa-*` prefixes.
