import { useState } from "react";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { UnresolvedOperationsSection } from "../components/sync/UnresolvedOperationsSection";
import { ExportQueueDialog } from "../components/sync/ExportQueueDialog";
import { useTranslation } from "../hooks/useTranslation";

// Deployment-blocker pass: a signed-in user's OWN unresolved online
// operations (e.g. a MANAGER's supplier payment whose reply was lost). Read
// only lookups (Check) and an unchanged own Retry; no organisation-wide view,
// no Mark verified, no set-aside — those stay on the owner's Sync page. The
// server applies its own rules to every lookup and retry (086: identity from
// the session, own keys only, never a fence from a lookup).
export const MyUnresolvedOperationsPage = () => {
  const { t } = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);
  return (
    <Card>
      <PageHeader title={t("unresolved", "ownTitle")} subtitle={t("unresolved", "ownHint")} />
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)} data-testid="own-export-open">
          {t("queueExport", "buttonLong")}
        </Button>
      </div>
      <ExportQueueDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <UnresolvedOperationsSection isOwner={false} mode="own" />
    </Card>
  );
};
