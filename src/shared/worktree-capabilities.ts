import { t as tr } from "./i18n";
/** UI deadline does not cancel a metadata write; an explicit retry reconciles. */
export const TOPIC_CONTEXT_PREPARE_TIMEOUT_MS = 300000;
export const linkedContextExecutionBlocker = () =>
  tr("host.thisGogaVersionDoesNotPassTheRequiredGitData");
export const contextIntegrationBlocker = () =>
  tr("host.processToContextBindingIsNotEnabledInThisIntermediate");
