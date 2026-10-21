import { useAuthStore } from "../stores/authStore";
import { userMayViewCost } from "../stores/data/costPrivacy";
import { useDataStore } from "../stores/dataStore";

/** Purchase cost / COGS are shown only with report:shop_profit (P-4). The
 *  server enforces it (PCOST-A); this keeps screens from inviting a cost
 *  that the person may not see or set. Same rule as `userMayViewCost`
 *  (the non-hook form used by the data layer). */
export const useCanViewCost = (): boolean => {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  return useDataStore((state) => userMayViewCost(state.users, currentUserId));
};
