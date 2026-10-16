# Coverage matrix — migration 081

Gate: **PASS** — 119/119 required items mapped; 0 hard gaps.

| # | kind | item | classification | tests |
|---|---|---|---|---|
| ✓ | org-scoped table | `public.audit_logs` | org-scoped | tables-0184, tables-0185, tables-0186, tables-0187 |
| ✓ | org-scoped table | `public.brands` | org-scoped | tables-0065, tables-0066, tables-0067, tables-0068 |
| ✓ | org-scoped table | `public.business_profile` | org-scoped | tables-0093, tables-0094, tables-0095, tables-0096 |
| ✓ | org-scoped table | `public.categories` | org-scoped | tables-0058, tables-0059, tables-0060, tables-0061 |
| ✓ | org-scoped table | `public.inventory` | org-scoped | tables-0100, tables-0101, tables-0102, tables-0103 |
| ✓ | org-scoped table | `public.inventory_movements` | org-scoped | tables-0107, tables-0108, tables-0109, tables-0110 |
| ✓ | org-scoped table | `public.organizations` | org-scoped | authz-0357 |
| ✓ | org-scoped table | `public.price_levels` | org-scoped | tables-0051, tables-0052, tables-0053, tables-0054 |
| ✓ | org-scoped table | `public.price_tiers` | org-scoped | tables-0044, tables-0045, tables-0046, tables-0047 |
| ✓ | org-scoped table | `public.product_barcodes` | org-scoped | tables-0037, tables-0038, tables-0039, tables-0040 |
| ✓ | org-scoped table | `public.product_image_upload_sessions` | org-scoped | tables-0191, tables-0192, tables-0193, tables-0194 |
| ✓ | org-scoped table | `public.product_unit_prices` | org-scoped | tables-0030, tables-0031, tables-0032, tables-0033 |
| ✓ | org-scoped table | `public.product_units` | org-scoped | tables-0023, tables-0024, tables-0025, tables-0026 |
| ✓ | org-scoped table | `public.products` | org-scoped | tables-0016, tables-0017, tables-0018, tables-0019 |
| ✓ | org-scoped table | `public.purchase_order_items` | org-scoped | tables-0142, tables-0143, tables-0144, tables-0145 |
| ✓ | org-scoped table | `public.purchase_orders` | org-scoped | tables-0135, tables-0136, tables-0137, tables-0138 |
| ✓ | org-scoped table | `public.rbac_assignment_violations` | org-scoped | helpers-0388 |
| ✓ | org-scoped table | `public.refund_void_requests` | org-scoped | tables-0170, tables-0171, tables-0172, tables-0173 |
| ✓ | org-scoped table | `public.reprint_logs` | org-scoped | tables-0177, tables-0178, tables-0179, tables-0180 |
| ✓ | org-scoped table | `public.sale_items` | org-scoped | tables-0128, tables-0129, tables-0130, tables-0131 |
| ✓ | org-scoped table | `public.sales` | org-scoped | tables-0121, tables-0122, tables-0123, tables-0124 |
| ✓ | org-scoped table | `public.shifts` | org-scoped | tables-0114, tables-0115, tables-0116, tables-0117 |
| ✓ | org-scoped table | `public.shops` | org-scoped | tables-0002, tables-0003, tables-0004, tables-0005 |
| ✓ | org-scoped table | `public.stock_transfer_items` | org-scoped | tables-0156, tables-0157, tables-0158, tables-0159 |
| ✓ | org-scoped table | `public.stock_transfers` | org-scoped | tables-0149, tables-0150, tables-0151, tables-0152 |
| ✓ | org-scoped table | `public.supplier_payments` | org-scoped | tables-0163, tables-0164, tables-0165, tables-0166 |
| ✓ | org-scoped table | `public.supplier_products` | org-scoped | tables-0086, tables-0087, tables-0088, tables-0089 |
| ✓ | org-scoped table | `public.suppliers` | org-scoped | tables-0079, tables-0080, tables-0081, tables-0082 |
| ✓ | org-scoped table | `public.unit_types` | org-scoped | tables-0072, tables-0073, tables-0074, tables-0075 |
| ✓ | org-scoped table | `public.users` | org-scoped | tables-0009, tables-0010, tables-0011, tables-0012 |
| ✓ | storage policy | `storage.objects:product_images_delete` |  | storage-0258, storage-0259, storage-0260, storage-0261 |
| ✓ | storage policy | `storage.objects:product_images_insert` |  | storage-0253, storage-0254, storage-0255, storage-0256 |
| ✓ | storage policy | `storage.objects:product_images_read` |  | storage-0250, storage-0251, storage-0252, storage-0265 |
| ✓ | storage policy | `storage.objects:product_images_update` |  | storage-0253, storage-0254, storage-0255, storage-0256 |
| ✓ | api function | `public.adjust_stock` | authenticated | rpcs-0217, rpcs-0245, authz-0325, authz-0326 |
| ✓ | api function | `public.app_can_for_shop` | authenticated | helpers-0370, helpers-0371 |
| ✓ | api function | `public.app_has_perm` | authenticated | helpers-0369 |
| ✓ | api function | `public.app_org_id` | authenticated | helpers-0365 |
| ✓ | api function | `public.app_org_shop_ids` | authenticated | helpers-0373 |
| ✓ | api function | `public.app_org_user_ids` | authenticated | helpers-0374 |
| ✓ | security-definer (service-role-only) | `public.app_require_org` | service_role-only | helpers-0391 |
| ✓ | security-definer (service-role-only) | `public.app_require_org_items` | service_role-only | helpers-0392 |
| ✓ | api function | `public.app_role` | authenticated | helpers-0366 |
| ✓ | security-definer (service-role-only) | `public.app_seed_default_price_levels` | service_role-only | helpers-0393 |
| ✓ | api function | `public.app_setup_needed` | anon+auth | authz-0362 |
| ✓ | api function | `public.app_shop_id` | authenticated | helpers-0368 |
| ✓ | api function | `public.app_shop_in_org` | authenticated | helpers-0372 |
| ✓ | api function | `public.app_storage_can_write_path` | authenticated | helpers-0376, helpers-0377 |
| ✓ | api function | `public.app_storage_object_in_my_org` | authenticated | helpers-0378 |
| ✓ | security-definer (service-role-only) | `public.app_storage_object_org` | service_role-only | helpers-0394 |
| ✓ | api function | `public.app_storage_owner_in_org` | authenticated | helpers-0379 |
| ✓ | api function | `public.app_user_id` | authenticated | helpers-0367 |
| ✓ | api function | `public.approve_purchase_order` | authenticated | rpcs-0219 |
| ✓ | api function | `public.approve_refund_request` | authenticated | rpcs-0232 |
| ✓ | api function | `public.approve_stock_transfer` | authenticated | rpcs-0226 |
| ✓ | api function | `public.approve_void_request` | authenticated | rpcs-0234 |
| ✓ | api function | `public.attach_product_image_upload_session_token` | authenticated | helpers-0386 |
| ✓ | api function | `public.bootstrap_first_admin` | authenticated | helpers-0387 |
| ✓ | api function | `public.cancel_product_image_upload_session` | authenticated | helpers-0385 |
| ✓ | api function | `public.cancel_purchase_order` | authenticated | rpcs-0220 |
| ✓ | api function | `public.cancel_stock_transfer` | authenticated | rpcs-0228 |
| ✓ | security-definer (service-role-only) | `public.claim_phone_upload_token_issue` | service_role-only | helpers-0395 |
| ✓ | api function | `public.close_shift` | authenticated | rpcs-0215 |
| ✓ | api function | `public.complete_product_image_upload_session` | anon+auth | phone-0278 |
| ✓ | api function | `public.complete_sale` | authenticated | rpcs-0216, authz-0363 |
| ✓ | security-definer (service-role-only) | `public.complete_stock_transfer` | service_role-only | helpers-0396 |
| ✓ | api function | `public.create_app_user` | authenticated | rpcs-0242, authlink-0311, authlink-0312, authlink-0313 |
| ✓ | api function | `public.create_product_image_upload_session` | authenticated | rpcs-0243, phone-0271, phone-0272, phone-0273 |
| ✓ | api function | `public.create_purchase_order` | authenticated | rpcs-0218 |
| ✓ | api function | `public.create_refund_void_request` | authenticated | rpcs-0231 |
| ✓ | api function | `public.create_stock_transfer` | authenticated | rpcs-0225 |
| ✓ | api function | `public.create_supplier` | authenticated | rpcs-0246 |
| ✓ | api function | `public.current_app_user` | authenticated | authz-0352, helpers-0375 |
| ✓ | api function | `public.deactivate_app_user` | authenticated | rpcs-0240 |
| ✓ | api function | `public.delete_product` | authenticated | rpcs-0237 |
| ✓ | api function | `public.dispatch_stock_transfer` | authenticated | rpcs-0229 |
| ✓ | api function | `public.get_product_image_upload_session_by_token` | anon+auth | phone-0274, phone-0275 |
| ✓ | api function | `public.get_product_image_upload_session_status` | authenticated | helpers-0384 |
| ✓ | security-definer (service-role-only) | `public.idem_begin` | service_role-only | helpers-0397 |
| ✓ | security-definer (service-role-only) | `public.idem_finish` | service_role-only | helpers-0398 |
| ✓ | api function | `public.log_audit_event` | authenticated | rpcs-0236 |
| ✓ | api function | `public.log_receipt_reprint` | authenticated | rpcs-0235 |
| ✓ | api function | `public.open_shift` | authenticated | rpcs-0214 |
| ✓ | api function | `public.pay_supplier_lump_sum` | authenticated | rpcs-0223 |
| ✓ | api function | `public.product_image_upload_token_hash` | authenticated | helpers-0382 |
| ✓ | security-definer (service-role-only) | `public.prune_idempotency_keys` | service_role-only | helpers-0399 |
| ✓ | api function | `public.receive_purchase_order` | authenticated | rpcs-0221 |
| ✓ | api function | `public.receive_stock_transfer` | authenticated | rpcs-0230 |
| ✓ | api function | `public.record_supplier_payment` | authenticated | rpcs-0222 |
| ✓ | api function | `public.reject_refund_void_request` | authenticated | rpcs-0233 |
| ✓ | api function | `public.reject_stock_transfer` | authenticated | rpcs-0227 |
| ✓ | api function | `public.replace_manager` | authenticated | rpcs-0241 |
| ✓ | api function | `public.resolve_event_time` | authenticated | helpers-0381 |
| ✓ | api function | `public.role_default_permissions` | authenticated | helpers-0380 |
| ✓ | api function | `public.transfer_json` | authenticated | helpers-0383 |
| ✓ | api function | `public.update_app_user` | authenticated | rpcs-0239 |
| ✓ | api function | `public.update_supplier` | authenticated | rpcs-0238 |
| ✓ | api function | `public.void_supplier_payment` | authenticated | rpcs-0224 |
| ✓ | api function | `storage.allow_any_operation` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.allow_only_operation` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.can_insert_object` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.extension` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.filename` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.foldername` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.get_common_prefix` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.get_size_by_bucket` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.list_multipart_uploads_with_delimiter` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.list_objects_with_delimiter` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.operation` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.search` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.search_by_timestamp` | anon+auth | helpers-0400 |
| ✓ | api function | `storage.search_v2` | anon+auth | helpers-0400 |
| ✓ | edge function | `admin-2fa` |  | functions-0304, functions-0305, functions-0306 |
| ✓ | edge function | `email-sales-report` |  | functions-0307, functions-0308, functions-0309 |
| ✓ | edge function | `phone-upload-token` |  | phone-0276, phone-0277 |
| ✓ | edge function | `phone-upload-page` |  | helpers-0389, helpers-0390 |
| ✓ | edge function | `platform-console` |  | functions-0294, functions-0295, functions-0296, functions-0297 |
| ✓ | edge function | `staff-admin` |  | functions-0281, functions-0282, functions-0283, functions-0284 |
| ✓ | extra | `edge-fn:signup` |  | functions-0310 |
