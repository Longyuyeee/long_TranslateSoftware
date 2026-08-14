const MANUAL_CHROME_LOAD_REASON =
  "Official Chrome builds disable command-line extension loading; use chrome://extensions for the release smoke.";

const MANUAL_CHROME_DEBUG_REASON =
  "Official Chrome did not expose an automation debugging endpoint; use chrome://extensions for the release smoke.";

export function manualChromeRuntimeReason(error) {
  if (!(error instanceof Error)) return null;
  if (error.message.includes("ERR_BLOCKED_BY_CLIENT")) {
    return MANUAL_CHROME_LOAD_REASON;
  }
  if (error.message.includes("did not open its debugging endpoint")) {
    return MANUAL_CHROME_DEBUG_REASON;
  }
  return null;
}
