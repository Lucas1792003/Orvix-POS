import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useTranslation } from "../../hooks/useTranslation";
import { formatDateTime } from "../../lib/utils";
import {
  registerOperationPrompt, type PromptDecision, type UnresolvedPromptRequest,
} from "../../stores/data/operationPrompt";

// The person's decision when something about to be sent looks like an
// operation whose outcome is still unknown (stores/data/operationPrompt.ts).
// Mounted once, in App. Closing the dialog any other way means "do nothing".
export const UnresolvedOperationPrompt = () => {
  const { t } = useTranslation();
  const [pending, setPending] = useState<{ request: UnresolvedPromptRequest; resolve: (d: PromptDecision) => void } | null>(null);

  useEffect(() => {
    registerOperationPrompt((request) => new Promise<PromptDecision>((resolve) => setPending({ request, resolve })));
    return () => registerOperationPrompt(null);
  }, []);

  const decide = (decision: PromptDecision) => {
    pending?.resolve(decision);
    setPending(null);
  };

  if (!pending) return null;
  const { request } = pending;
  const similar = request.overlap === "similar";
  return (
    <Modal
      open
      title={t("unresolved", "promptTitle")}
      description={t("unresolved", similar ? "promptSimilarBody" : "promptBody")}
      onClose={() => decide("cancel")}
      size="sm"
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button variant="secondary" onClick={() => decide("cancel")}>{t("unresolved", "promptCancel")}</Button>
          {request.allowAdditional && (
            <Button variant="secondary" onClick={() => decide("additional")}>{t("unresolved", "promptAdditional")}</Button>
          )}
          {request.allowNew && (
            <Button variant="secondary" onClick={() => decide("new")}>{t("unresolved", similar ? "promptReplace" : "promptNew")}</Button>
          )}
          {request.allowRetry && (
            <Button onClick={() => decide("retry")}>{t("unresolved", "promptRetry")}</Button>
          )}
        </div>
      }
    >
      <ul className="space-y-2">
        {request.existing.map((e, i) => (
          <li key={i} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <div className="font-medium">{e.summary}</div>
            <div className="text-xs text-amber-800">{t("unresolved", "earlier")} · {formatDateTime(e.createdAt)}</div>
          </li>
        ))}
      </ul>
    </Modal>
  );
};
