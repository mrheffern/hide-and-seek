import { sendCommand } from "../api";
import { flushDiagnostics, recordDiagnosticError } from "../diagnostics";
import { stopMatchTracking } from "../location/tracking";
import { clearSession as clearStoredSession, type StoredSession } from "../session";

/** Complete device cleanup before telling the server that this player left. */
export async function leavePartySession(session: StoredSession): Promise<void> {
  await stopMatchTracking();
  await clearStoredSession().catch((error) => recordDiagnosticError("lifecycle", "session_clear_failed", error));
  let flushDeadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flushDiagnostics(session, true),
    new Promise<void>((resolve) => { flushDeadline = setTimeout(resolve, 1_000); }),
  ]).catch((error) => recordDiagnosticError("diagnostics", "leave_flush_failed", error));
  if (flushDeadline) clearTimeout(flushDeadline);
  try {
    await sendCommand(session, { type: "leave_party" });
  } catch {
    // Local cleanup still succeeds if the network is unavailable.
  }
}
