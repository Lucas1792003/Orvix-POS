-- sweep-abandoned-uploads.sql — READ-ONLY candidate query for
-- sweep-abandoned-uploads.sh (G5 follow-up, docs/selfhost-migration/phase-f/
-- g5-followups.md §2). It never writes: the script runs it in a READ ONLY
-- transaction and deletes the objects itself through storage-api.
--
-- psql variables: grace_hours (integer >= 1).
-- Output (tab-separated, one row per object, no header):
--   verdict  object_name  session_status  object_age_hours  size_bytes
-- verdict:
--   delete      abandoned upload: may be removed
--   referenced  abandoned-shaped but some products.image_url /
--               business_profile.logo_url / session public_url points at it:
--               KEPT, reported for manual review
--
-- An object is a candidate ONLY when ALL of these hold:
--   1. bucket product-images, name = org/<org>/temp/pimg-<32 hex>
--      (the server-minted session layout of 079+). Every legacy name
--      (temp/<id>, products/<id>/..., products/brand/...) - which includes
--      all 574 migrated objects and the 17 historical orphans - can never
--      match this pattern;
--   2. a session row exists whose storage_path is exactly this name, whose id
--      is the name's last segment and whose creator belongs to the name's
--      org segment (objects without such a row are never touched);
--   3. the session never completed: status <> COMPLETED, completed_at NULL,
--      public_url NULL, and it is EXPIRED / CANCELED, or PENDING past its
--      expires_at (an expired session can never complete: the completion RPC
--      refuses it);
--   4. session created, session expired, and object created all more than
--      grace_hours ago.
-- The script additionally drops every name whose sha256 is in the allow-list
-- file (the 574 existing object names) before deleting anything.

\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SELECT CASE WHEN r.referenced THEN 'referenced' ELSE 'delete' END,
       r.name, r.status, r.age_hours, r.size_bytes
  FROM (
    SELECT o.name,
           s.status,
           floor(extract(epoch FROM now() - o.created_at) / 3600)::bigint AS age_hours,
           CASE WHEN o.metadata->>'size' ~ '^[0-9]{1,18}$' THEN (o.metadata->>'size')::bigint ELSE 0 END AS size_bytes,
           (   EXISTS (SELECT 1 FROM public.products p
                        WHERE p.image_url IS NOT NULL AND position('/product-images/' || o.name IN p.image_url) > 0)
            OR EXISTS (SELECT 1 FROM public.business_profile b
                        WHERE b.logo_url IS NOT NULL AND position('/product-images/' || o.name IN b.logo_url) > 0)
            OR EXISTS (SELECT 1 FROM public.product_image_upload_sessions s2
                        WHERE s2.public_url IS NOT NULL AND position('/product-images/' || o.name IN s2.public_url) > 0)
           ) AS referenced
      FROM storage.objects o
      JOIN public.product_image_upload_sessions s ON s.storage_path = o.name
      JOIN public.users u ON u.id = s.created_by
     WHERE o.bucket_id = 'product-images'
       AND o.name ~ '^org/[A-Za-z0-9_-]+/temp/pimg-[0-9a-f]{32}$'
       AND split_part(o.name, '/', 4) = s.id
       AND split_part(o.name, '/', 2) = u.org_id
       AND s.status <> 'COMPLETED'
       AND s.completed_at IS NULL
       AND s.public_url IS NULL
       AND (s.status IN ('EXPIRED', 'CANCELED') OR (s.status = 'PENDING' AND s.expires_at < now()))
       AND s.created_at < now() - make_interval(hours => :grace_hours)
       AND s.expires_at < now() - make_interval(hours => :grace_hours)
       AND o.created_at < now() - make_interval(hours => :grace_hours)
  ) r
 ORDER BY r.name;
COMMIT;
