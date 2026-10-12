import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import type { DiagnosticsPage, StoredDiagnosticEvent } from "@hide-and-seek/protocol";
import type { StoredSession } from "../session";
import { flushDiagnostics, getDiagnosticContext, recordDiagnostic, recordDiagnosticError } from ".";
import { pendingDiagnosticCount } from "./store";
import { fetchWithDeadline } from "../network/request";

export interface DiagnosticsExportResult {
  count: number;
  disposition: "saved" | "shared";
  fileName: string;
  fileUri: string;
}

async function saveOrShare(fileName: string, cacheUri: string, contents: string): Promise<Pick<DiagnosticsExportResult, "disposition" | "fileUri">> {
  if (Platform.OS === "android") {
    try {
      const downloadsUri = FileSystem.StorageAccessFramework.getUriForDirectoryInRoot("Download");
      const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(downloadsUri);
      if (permission.granted) {
        const destinationUri = await FileSystem.StorageAccessFramework.createFileAsync(
          permission.directoryUri,
          fileName.replace(/\.json$/i, ""),
          "application/json",
        );
        await FileSystem.StorageAccessFramework.writeAsStringAsync(destinationUri, contents, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        return { disposition: "saved", fileUri: destinationUri };
      }
    } catch (error) {
      recordDiagnosticError("diagnostics", "export_save_failed", error, { fileName });
    }
  }

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(cacheUri, {
      mimeType: "application/json",
      dialogTitle: Platform.OS === "ios" ? "Save or share Out of Sight diagnostics" : "Share Out of Sight diagnostics",
      UTI: "public.json",
    });
    return { disposition: "shared", fileUri: cacheUri };
  }
  throw new Error("Choose a folder to save the diagnostics, or enable a system sharing app and try again.");
}

export async function exportDiagnostics(session: StoredSession, matchId?: string): Promise<DiagnosticsExportResult> {
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
  const fileName = `out-of-sight-${session.roomCode}-${scope}-${timestamp}.json`;
  const cacheUri = `${FileSystem.cacheDirectory}${fileName}`;
  const contents = JSON.stringify({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    roomCode: session.roomCode,
    matchId,
    eventCount: events.length,
    untilSequence,
    localPendingEventCount: pendingDiagnosticCount(session),
    events,
  }, null, 2);
  await FileSystem.writeAsStringAsync(cacheUri, contents, { encoding: FileSystem.EncodingType.UTF8 });
  const destination = await saveOrShare(fileName, cacheUri, contents);
  recordDiagnostic({
    category: "diagnostics",
    name: "export_completed",
    payload: { matchId, count: events.length, disposition: destination.disposition, fileName },
    context,
  });
  return { count: events.length, fileName, ...destination };
}
