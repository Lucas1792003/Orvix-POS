import type { StateCreator } from "zustand";
import type { DataState, AuditState } from "../types";
import type { AuditLog, ReprintLog } from "../../../types";
import { newIdempotencyKey, ONLINE_ONLY_RETRIES } from "../idempotentRpc";
import { callOnlineOnly } from "../onlineOnly";

interface AuditEventResult {
  auditLog: AuditLog;
}

interface ReprintResult {
  reprintLog: ReprintLog;
  auditLog: AuditLog;
}

export const createAuditSlice: StateCreator<DataState, [], [], AuditState> = (set) => ({
  auditLogs: [],
  reprintLogs: [],

  addAuditLog: async (log: AuditLog) => {
    const { data, error } = await callOnlineOnly("log_audit_event", {
      p_action_type: log.actionType,
      p_message: log.message,
      p_entity_type: log.entityType,
      p_entity_id: log.entityId,
      p_shop_id: log.shopId ?? null,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Audit event returned no data.");
    const result = data as AuditEventResult;

    set((state) => ({ auditLogs: [result.auditLog, ...state.auditLogs] }));
  },

  addReprintLog: async ({ saleId }) => {
    const { data, error } = await callOnlineOnly("log_receipt_reprint", {
      p_sale_id: saleId,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Receipt reprint returned no data.");
    const result = data as ReprintResult;

    set((state) => ({
      reprintLogs: [result.reprintLog, ...state.reprintLogs],
      auditLogs: [result.auditLog, ...state.auditLogs],
    }));
  },
});
