import { useAuthStore } from "../stores/authStore";
import { useDataStore } from "../stores/dataStore";
import { hasPermission } from "./permissions";

/** Purchase cost / COGS are shown only with report:shop_profit (P-4). The
 *  server enforces it (PCOST-A); this keeps screens from inviting a cost
 *  that the person may not see or set. */
export const useCanViewCost = (): boolean => {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const me = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  return hasPermission(me, "report:shop_profit");
};
