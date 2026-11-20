import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import type { BuildRepeatPreparation } from "../shared/build-repeat";

/** Never suggests that sensitive values were restored from persisted history. */
export function BuildRepeatNotice({
  preparation,
  missingEnvKeys,
  missingProxy,
  reviewed,
  onReview,
  ownerError,
}: {
  preparation: BuildRepeatPreparation;
  missingEnvKeys: string[];
  missingProxy: boolean;
  reviewed: boolean;
  onReview: (reviewed: boolean) => void;
  ownerError?: string;
}) {
  useLocale();
  return (
    <section
      className="build-group build-group-body"
      aria-label={tr("launch.prepareRepeatBuild")}
    >
      <h3>{tr("launch.reviewTheRepeatBuildSettings")}</h3>
      {preparation.legacyIncomplete && (
        <p className="error" role="note">{tr("launch.onlyASummaryOfThisOlderRunIs")}</p>
      )}
      <p className="hint">{tr("launch.onlyNonSecretSettingsAndThePlanPath")}</p>
      {preparation.requiredEnvKeys.length > 0 && (
        <>
          <p>{tr("launch.variableValuesWereNotSavedForThisRun")}</p>
          <ul>
            {preparation.requiredEnvKeys.map((key) => (
              <li key={key}>
                <code>{key}</code> —{" "}
                {missingEnvKeys.includes(key)
                  ? tr("launch.valueRequired")
                  : tr("launch.reEntered")}
              </li>
            ))}
          </ul>
        </>
      )}
      {preparation.requiresProxy && (
        <p>
          {missingProxy
            ? tr("launch.theProxyWasNotSavedReEnterIts")
            : tr("launch.proxyReEntered")}
        </p>
      )}
      {(missingEnvKeys.length > 0 || missingProxy) && (
        <p className="hint">{tr("launch.theListedValuesAreRequiredToRepeatThis")}</p>
      )}
      {ownerError && (
        <p className="error" role="alert">
          {ownerError}
        </p>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={missingEnvKeys.length > 0 || missingProxy || !!ownerError}
          onChange={(event) => onReview(event.target.checked)}
        />{tr("launch.iHaveReviewedTheBuildSettingsAndRe")}</label>
    </section>
  );
}
