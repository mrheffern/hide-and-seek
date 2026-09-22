import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { DiagnosticsPage, StoredDiagnosticEvent } from "@hide-and-seek/protocol";
import type { StoredSession } from "../session";
import { flushDiagnostics, getDiagnosticContext, recordDiagnostic } from ".";
import { pendingDiagnosticCount } from "./store";
import { fetchWithDeadline } from "../network/request";

export async function exportDiagnostics(session: StoredSession, matchId?: string): Promise<{ count: number; fileUri: string }> {
  const context = getDiagnosticContext();
  recordDiagnostic({ category: "diagnostics", name: "export_started", payload: { matchId }, context });
  await flushDiagnostics(session, true);
  const events: StoredDiagnosticEvent[] = [];
  let after = 0;
  let untilSequence: number | undefined;
  for (;;) {
    const query = new URLSearchParams({ after: String(after), limit: "1000" });
    if (matchId) query.set("matchId", matchId);
    if (untilSequence !== undefined) query.set("untilSequence", String(untilSequence));
    const { response, text } = await fetchWithDeadline(`${session.apiUrl}/rooms/${session.roomCode}/diagnostics?${query}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) throw new Error(`Diagnostics export failed (${response.status}).`);
    const page = JSON.parse(text) as DiagnosticsPage;
    if (!Array.isArray(page.events) || page.roomCode !== session.roomCode) throw new Error("Invalid diagnostics export response.");
    untilSequence ??= page.untilSequence;
    events.push(...page.events);
    if (page.nextAfter === undefined) break;
    if (!Number.isSafeInteger(page.nextAfter) || page.nextAfter <= after || events.length > 100_000) {
      throw new Error("Diagnostics export pagination did not advance. Please retry.");
    }
    after = page.nextAfter;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scope = matchId ? `match-${matchId.slice(0, 24)}` : "party";
  if (!FileSystem.cacheDirectory) throw new Error("Diagnostic export storage is unavailable on this device.");
  const fileUri = `${FileSystem.cacheDirectory}out-of-sight-${session.roomCode}-${scope}-${timestamp}.json`;
  await FileSystem.writeAsStringAsync(fileUri, JSON.stringify({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    roomCode: session.roomCode,
    matchId,
    eventCount: events.length,
    untilSequence,
    localPendingEventCount: pendingDiagnosticCount(session),
    events,
  }, null, 2));
  recordDiagnostic({ category: "diagnostics", name: "export_completed", payload: { matchId, count: events.length }, context });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(fileUri, { mimeType: "application/json", dialogTitle: "Share Out of Sight diagnostics" });
  }
  return { count: events.length, fileUri };
}
