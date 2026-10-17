import type { StateCreator } from "zustand";
import type { CreateStaffInput, DataState, ShopState } from "../types";
import type { BusinessProfile, Shop, User } from "../../../types";
import { supabase } from "../../../lib/supabase";
import { mapShopFormError, normalizeShopInput } from "../../../lib/shopValidation";
import {
  SHOP_DELETE_MESSAGES,
  countShopReferences,
  formatShopReferenceSummary,
  mapShopDeleteError,
} from "../../../lib/shopDelete";
import { useAppStore } from "../../appStore";
import { writeTableRow } from "../tableWrite";
import { newIdempotencyKey, ONLINE_ONLY_RETRIES } from "../idempotentRpc";
import { callOnlineOnly } from "../onlineOnly";
import { createStaffAccount } from "../../../lib/staffAdmin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const execShopWrite = async (query: PromiseLike<{ error: any }>, label: string): Promise<void> => {
  const { error } = await query;
  if (error) {
    console.error(`[DB] ${label} failed:`, error);
    throw new Error(mapShopFormError(error));
  }
};

export const createShopSlice: StateCreator<DataState, [], [], ShopState> = (set, get) => ({
  shops: [],
  users: [],
  businessProfile: null,

  // Update the singleton business brand (id = 'default'). ADMIN-gated by
  // RLS. Not offline-capable — it's a rare, low-urgency desk edit and its
  // singleton shape (keyed "default", not "id") doesn't fit the generic
  // table-write helper the rest of this file uses.
  updateBusinessProfile: async (profile: BusinessProfile) => {
    await execShopWrite(
      supabase
        .from("business_profile")
        .update({
          business_name: profile.businessName?.trim() || null,
          logo_url: profile.logoUrl?.trim() || null,
          address: profile.address?.trim() || null,
          phone: profile.phone?.trim() || null,
          email: profile.email?.trim() || null,
          tagline: profile.tagline?.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", "default"),
      "Update business profile",
    );
    set({ businessProfile: profile });
  },

  addShop: async (shop: Shop) => {
    const normalized = normalizeShopInput(shop);
    const savedShop = { ...shop, ...normalized };
    // Persist first — only show the shop locally once the database confirms it.
    await execShopWrite(
      writeTableRow({
        table: "shops", op: "insert", id: savedShop.id,
        row: {
          id: savedShop.id, code: savedShop.code, name: savedShop.name, address: savedShop.address,
          phone: savedShop.phone ?? null, email: savedShop.email ?? null,
          is_active: savedShop.isActive, created_at: savedShop.createdAt,
        },
        appRow: savedShop,
      }),
      "Add shop"
    );
    set((state) => ({ shops: [...state.shops, savedShop] }));
  },

  updateShop: async (shop: Shop) => {
    const normalized = normalizeShopInput(shop);
    const savedShop = { ...shop, ...normalized };
    await execShopWrite(
      writeTableRow({
        table: "shops", op: "update", id: savedShop.id,
        row: {
          code: savedShop.code, name: savedShop.name, address: savedShop.address,
          phone: savedShop.phone ?? null, email: savedShop.email ?? null, is_active: savedShop.isActive,
        },
        appRow: savedShop,
      }),
      "Update shop"
    );
    set((state) => ({
      shops: state.shops.map((item) => (item.id === savedShop.id ? savedShop : item)),
    }));
  },

  deleteShop: async (shopId: string) => {
    // Local pre-check using already-loaded store data. ShopsPage is ADMIN-only,
    // so the store holds the full row set; the DB FK constraints on users /
    // inventory / supplier_payments / price_tiers are still the final guard
    // for anything missed (e.g. rows created since the last loadData).
    const state = get();
    const counts = countShopReferences(shopId, {
      users: state.users,
      inventory: state.inventory,
      shifts: state.shifts,
      sales: state.sales,
      purchaseOrders: state.purchaseOrders,
      supplierPayments: state.supplierPayments,
      stockTransfers: state.stockTransfers,
      priceTiers: state.priceTiers,
      refundVoidRequests: state.refundVoidRequests,
      auditLogs: state.auditLogs,
    });
    if (counts.total > 0) {
      throw new Error(
        `${SHOP_DELETE_MESSAGES.referenced} References: ${formatShopReferenceSummary(counts)}.`
      );
    }
    const { error } = await writeTableRow({ table: "shops", op: "delete", id: shopId, row: {} });
    if (error) {
      console.error(`[DB] Delete shop failed:`, error);
      throw new Error(mapShopDeleteError(error));
    }
    set((state) => ({ shops: state.shops.filter((s) => s.id !== shopId) }));
    const { currentShopId, setShopId } = useAppStore.getState();
    if (currentShopId === shopId) setShopId(null);
  },

  createStaffUser: async (input: CreateStaffInput) => {
    // The auth account and the users row are created server-side by the
    // staff-admin Edge Function (GoTrue admin API + create_app_user() as the
    // caller); the browser never calls auth sign-up.
    const user = await createStaffAccount(input);
    set((state) => ({ users: state.users.some((u) => u.id === user.id) ? state.users : [...state.users, user] }));
    return user;
  },

  updateUser: async (user: User) => {
    const { data, error } = await callOnlineOnly("update_app_user", {
      p_id: user.id,
      p_name: user.name,
      p_role: user.role,
      p_shop_id: user.shopId ?? null,
      p_granted_permissions: user.grantedPermissions ?? null,
      p_revoked_permissions: user.revokedPermissions ?? null,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Update user returned no data.");
    const updated = data as User;
    set((state) => ({
      users: state.users.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
    }));
  },

  deactivateUser: async (userId: string, isActive: boolean) => {
    const { data, error } = await callOnlineOnly("deactivate_app_user", {
      p_id: userId,
      p_is_active: isActive,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Update user status returned no data.");
    const result = data as { id: string; isActive: boolean };
    set((state) => ({
      users: state.users.map((item) => (item.id === result.id ? { ...item, isActive: result.isActive } : item)),
    }));
  },

  replaceManager: async (shopId: string, newManagerId: string) => {
    const { error } = await callOnlineOnly("replace_manager", {
      p_shop_id: shopId,
      p_new_manager_id: newManagerId,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    // The RPC flips two rows server-side (old manager deactivated, new one
    // activated) — simplest correct way to reflect that locally is to pull
    // the affected rows back rather than reconstruct the swap by hand.
    const { data: refreshed, error: refreshError } = await supabase
      .from("users")
      .select("*")
      .eq("shop_id", shopId);
    if (refreshError || !refreshed) return;
    // The untyped client returns `{}` rows; the columns read below are the ones
    // replace_manager touches (see migration 049).
    type ManagerSwapRow = { id: string; role: string; shop_id: string | null; is_active: boolean };
    const byId = new Map((refreshed as ManagerSwapRow[]).map((row) => [row.id, row]));
    set((state) => ({
      users: state.users.map((item) => {
        const row = byId.get(item.id);
        if (!row) return item;
        return {
          ...item,
          role: row.role as User["role"], shopId: row.shop_id ?? undefined, isActive: row.is_active,
        };
      }),
    }));
  },
});
