import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { GameCommand, RoomSnapshot, SessionResponse } from "@hide-and-seek/protocol";
import { ApiRequestError, createParty, fetchSnapshot, joinParty, sendCommand, socketUrl } from "../api";
import { GAME_API_URL } from "../config";
import {
  refreshLobbyLocation,
  startMatchTracking,
  stopMatchBackgroundTracking,
  stopMatchTracking,
} from "../location/tracking";
import {
  clearSession as clearStoredSession,
  randomId,
  readSession,
  saveSession,
  type StoredSession,
} from "../session";
import { reconnectDelayMs, type ConnectionState } from "../reconnect";
import {
  clearDiagnosticContext,
  flushDiagnostics,
  recordDiagnostic,
  recordDiagnosticError,
  setDiagnosticContext,
} from "../diagnostics";
import { exportDiagnostics as exportDiagnosticsFile } from "../diagnostics/export";
import { leavePartySession } from "./leaveParty";
import { acceptsSnapshot, shouldTrackPlayer } from "./partyState";
import { consumeGameplaySoundCues } from "../audio/gameplaySoundEvents";
import { playGameplaySound } from "../audio/gameplayAudio";

function toStoredSession(response: SessionResponse): StoredSession {
  return {
    apiUrl: GAME_API_URL,
    roomCode: response.roomCode,
    playerId: response.playerId,
    token: response.token,
    locationSessionId: randomId("location"),
  };
}

export function useParty() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [busy, setBusy] = useState(true);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const mounted = useRef(true);
  const activeSession = useRef<StoredSession | null>(null);
  const latestSnapshot = useRef<RoomSnapshot | null>(null);
  const actionInFlight = useRef(false);

  const clearLocalParty = useCallback(async (message: string) => {
    activeSession.current = null;
    latestSnapshot.current = null;
    actionInFlight.current = false;
    await stopMatchTracking();
    await clearStoredSession().catch((error) => recordDiagnosticError("lifecycle", "session_clear_failed", error));
    if (!mounted.current) return;
    setSession(null);
    setSnapshot(null);
    setConnectionState("disconnected");
    setStatus(message);
    setBusy(false);
    clearDiagnosticContext();
  }, []);

  const applySnapshot = useCallback((next: RoomSnapshot, expectedSession: StoredSession) => {
    if (!mounted.current || activeSession.current !== expectedSession
      || !acceptsSnapshot(latestSnapshot.current, next, expectedSession)) return;
    latestSnapshot.current = next;
    const self = next.players.find((player) => player.id === next.selfId);
    setDiagnosticContext({
      apiUrl: expectedSession.apiUrl,
      roomCode: next.roomCode,
      playerId: next.selfId,
      playerName: self?.name,
      matchId: next.matchId,
    });
    for (const cue of consumeGameplaySoundCues(next)) {
      void playGameplaySound(cue.kind, cue.eventId);
    }
    recordDiagnostic({
      level: "debug",
      category: "state",
      name: "snapshot_received",
      payload: {
        version: next.version,
        serverNow: next.serverNow,
        phase: next.phase,
        winner: next.winner,
        players: next.players,
        boundaryPoints: next.boundary.length,
        traps: next.traps,
        immobilized: next.immobilized,
        outsideBoundary: next.outsideBoundary,
        nearBoundary: next.nearBoundary,
      },
    });
    setSnapshot(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      recordDiagnostic({ category: "lifecycle", name: "session_restore_started" });
      let stored: StoredSession | null;
      try {
        stored = await readSession();
      } catch (error) {
        recordDiagnosticError("lifecycle", "session_storage_failed", error);
        if (!cancelled && mounted.current) {
          setStatus("Could not restore the previous party. You can join again.");
          setBusy(false);
        }
        return;
      }
      if (cancelled || !mounted.current) return;
      if (!stored) {
        recordDiagnostic({ category: "lifecycle", name: "session_restore_empty" });
        await stopMatchTracking();
        if (cancelled || !mounted.current) return;
        setStatus("");
        setBusy(false);
        return;
      }
      if (stored.apiUrl.replace(/\/+$/, "") !== GAME_API_URL.replace(/\/+$/, "")) {
        recordDiagnostic({
          category: "lifecycle",
          name: "session_server_changed",
          payload: { previousApiUrl: stored.apiUrl, currentApiUrl: GAME_API_URL },
        });
        await clearLocalParty("The app server changed. Create or join the party again.");
        return;
      }
      setDiagnosticContext({ apiUrl: stored.apiUrl, roomCode: stored.roomCode, playerId: stored.playerId });
      activeSession.current = stored;
      setSession(stored);
      try {
        const nextSnapshot = await fetchSnapshot(stored);
        if (cancelled || !mounted.current || activeSession.current !== stored) return;
        applySnapshot(nextSnapshot, stored);
        recordDiagnostic({ category: "lifecycle", name: "session_restored", payload: { phase: nextSnapshot.phase, version: nextSnapshot.version } });
      } catch (error) {
        if (cancelled || !mounted.current || activeSession.current !== stored) return;
        recordDiagnosticError("lifecycle", "session_restore_failed", error);
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 404)) {
          await clearLocalParty("Previous party expired.");
        } else if (mounted.current) {
          setStatus("Reconnecting to your previous party…");
        }
      } finally {
        if (!cancelled && mounted.current) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [applySnapshot, clearLocalParty]);

  useEffect(() => {
    if (!session) return;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setInterval> | undefined;
    let attempt = 0;
    let closed = false;
    let refreshing = false;
    const isCurrent = () => !closed && mounted.current && activeSession.current === session;
    const refresh = async () => {
      if (!isCurrent() || refreshing) return;
      refreshing = true;
      recordDiagnostic({ level: "debug", category: "realtime", name: "fallback_refresh_started" });
      try {
        const next = await fetchSnapshot(session);
        if (!isCurrent()) return;
        applySnapshot(next, session);
      } catch (error) {
        if (!isCurrent()) return;
        recordDiagnosticError("realtime", "fallback_refresh_failed", error);
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 404)) {
          closed = true;
          socket?.close();
          await clearLocalParty("This party is no longer available.");
        }
      } finally {
        refreshing = false;
      }
    };
    const scheduleReconnect = () => {
      if (!isCurrent() || retry) return;
      setConnectionState("retrying");
      const delay = reconnectDelayMs(attempt);
      recordDiagnostic({ category: "realtime", name: "websocket_reconnect_scheduled", payload: { attempt, delayMs: delay } });
      attempt += 1;
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, delay);
    };
    const connect = () => {
      if (!isCurrent() || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
      setConnectionState(attempt ? "retrying" : "connecting");
      recordDiagnostic({ category: "realtime", name: "websocket_connect_started", payload: { attempt } });
      const current = new WebSocket(socketUrl(session), [`game-token.${session.token}`]);
      socket = current;
      current.onopen = () => {
        if (!isCurrent() || socket !== current) return;
        attempt = 0;
        setConnectionState("live");
        recordDiagnostic({ category: "realtime", name: "websocket_opened" });
        void flushDiagnostics(session, true);
        void refresh();
      };
      current.onmessage = (event) => {
        if (!isCurrent() || socket !== current) return;
        try {
          const message = JSON.parse(String(event.data)) as RoomSnapshot;
          recordDiagnostic({ level: "debug", category: "realtime", name: "websocket_message_received", payload: { bytes: String(event.data).length, type: message.type, version: message.version } });
          if (message.type === "snapshot") applySnapshot(message, session);
        } catch (error) {
          recordDiagnosticError("realtime", "websocket_message_unreadable", error, { bytes: String(event.data).length });
          setStatus("Received an unreadable game update.");
        }
      };
      current.onerror = (event) => {
        if (!isCurrent() || socket !== current) return;
        recordDiagnostic({ level: "error", category: "realtime", name: "websocket_error", payload: { eventType: event.type } });
        if (!closed && socket === current) setConnectionState("retrying");
      };
      current.onclose = (event) => {
        if (!isCurrent() || socket !== current) return;
        recordDiagnostic({ level: event.wasClean ? "info" : "warn", category: "realtime", name: "websocket_closed", payload: { code: event.code, reason: event.reason, wasClean: event.wasClean } });
        if (socket === current) socket = undefined;
        scheduleReconnect();
      };
    };
    connect();
    fallback = setInterval(() => {
      if (!isCurrent()) return;
      // Finished and eliminated players no longer have GPS uploads to flush their diagnostics.
      void flushDiagnostics(session);
      if (socket?.readyState !== WebSocket.OPEN) void refresh();
    }, 30_000);
    const appState = AppState.addEventListener("change", (nextState) => {
      recordDiagnostic({ category: "lifecycle", name: "app_state_changed", payload: { nextState } });
      if (nextState !== "active" || !isCurrent()) return;
      if (shouldTrackPlayer(latestSnapshot.current)) {
        void startMatchTracking().then((result) => {
          if (isCurrent() && shouldTrackPlayer(latestSnapshot.current) && !result.ready) setStatus(result.message);
        });
      } else if (latestSnapshot.current?.phase === "lobby"
        && latestSnapshot.current.players.find((player) => player.id === latestSnapshot.current?.selfId)?.status === "active"
        && !latestSnapshot.current.players.find((player) => player.id === latestSnapshot.current?.selfId)?.gpsReady) {
        void stopMatchBackgroundTracking().then(async () => {
          if (!isCurrent() || latestSnapshot.current?.phase !== "lobby") return;
          const result = await refreshLobbyLocation(session);
          if (!isCurrent()) return;
          if (result.snapshot) applySnapshot(result.snapshot, session);
          if (!result.ready) setStatus(result.message);
        });
      } else if (latestSnapshot.current) {
        void stopMatchTracking();
      }
      void refresh();
      if (socket?.readyState !== WebSocket.OPEN && socket?.readyState !== WebSocket.CONNECTING) {
        if (retry) clearTimeout(retry);
        retry = undefined;
        connect();
      }
    });
    return () => {
      recordDiagnostic({ category: "realtime", name: "websocket_effect_cleanup" });
      closed = true;
      if (retry) clearTimeout(retry);
      if (fallback) clearInterval(fallback);
      appState.remove();
      socket?.close();
    };
  }, [applySnapshot, clearLocalParty, session]);

  const selfStatus = snapshot?.players.find((player) => player.id === snapshot.selfId)?.status;
  const selfGpsReady = snapshot?.players.find((player) => player.id === snapshot.selfId)?.gpsReady;
  const gpsCheckEventId = snapshot?.phase === "lobby"
    ? [...snapshot.events].reverse().find((event) => event.type === "gps_check_requested")?.id
    : undefined;
  useEffect(() => {
    if (!session || !snapshot) return;
    let cancelled = false;
    if (shouldTrackPlayer(snapshot)) {
      void startMatchTracking().then((result) => {
        if (!cancelled && mounted.current && activeSession.current === session) setStatus(result.message);
      });
    } else if (snapshot.phase === "lobby" && selfStatus === "active" && !selfGpsReady) {
      void stopMatchBackgroundTracking().then(async () => {
        if (cancelled || !mounted.current || activeSession.current !== session || latestSnapshot.current?.phase !== "lobby") return;
        const result = await refreshLobbyLocation(session);
        if (cancelled || !mounted.current || activeSession.current !== session) return;
        if (result.snapshot) applySnapshot(result.snapshot, session);
        setStatus(result.message);
      });
    } else {
      void stopMatchTracking();
    }
    return () => { cancelled = true; };
  }, [applySnapshot, gpsCheckEventId, selfGpsReady, selfStatus, snapshot?.phase, session]);

  const begin = useCallback(async (operation: () => Promise<SessionResponse>) => {
    if (actionInFlight.current || activeSession.current) return;
    actionInFlight.current = true;
    setBusy(true);
    recordDiagnostic({ category: "party", name: "party_entry_started" });
    try {
      const response = await operation();
      const stored = toStoredSession(response);
      const self = response.snapshot.players.find((player) => player.id === response.playerId);
      await saveSession(stored);
      if (!mounted.current) return;
      setDiagnosticContext({ apiUrl: stored.apiUrl, roomCode: stored.roomCode, playerId: stored.playerId, playerName: self?.name, matchId: response.snapshot.matchId });
      activeSession.current = stored;
      latestSnapshot.current = null;
      setSession(stored);
      applySnapshot(response.snapshot, stored);
      recordDiagnostic({ category: "party", name: "party_entry_completed", payload: { roomCode: stored.roomCode } });
      void flushDiagnostics(stored, true);
    } catch (error) {
      recordDiagnosticError("party", "party_entry_failed", error);
      setStatus(error instanceof Error ? error.message : "Could not connect to the party.");
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [applySnapshot]);

  const create = useCallback((name: string) => begin(() => createParty(name)), [begin]);
  const join = useCallback(
    (roomCode: string, name: string) => begin(() => joinParty(roomCode.trim().toUpperCase(), name)),
    [begin],
  );

  const command = useCallback(
    async (value: GameCommand) => {
      if (!session || activeSession.current !== session || actionInFlight.current) return;
      actionInFlight.current = true;
      setBusy(true);
      recordDiagnostic({ category: "interaction", name: "command_button_pressed", payload: { command: value } });
      try {
        const result = await sendCommand(session, value);
        if (!mounted.current || activeSession.current !== session) return;
        setStatus(result.message);
        recordDiagnostic({ category: "interaction", name: "command_completed", payload: { command: value, result } });
        try {
          applySnapshot(await fetchSnapshot(session), session);
        } catch {
          // The WebSocket or reconnect poll will deliver the authoritative state.
        }
      } catch (error) {
        if (!mounted.current || activeSession.current !== session) return;
        recordDiagnosticError("interaction", "command_failed", error, { command: value });
        setStatus(error instanceof Error ? error.message : "Action failed.");
      } finally {
        if (activeSession.current === session) {
          actionInFlight.current = false;
          if (mounted.current) setBusy(false);
        }
      }
    },
    [applySnapshot, session],
  );

  const leave = useCallback(async () => {
    if (!session || activeSession.current !== session) return;
    // Invalidate callbacks immediately, before waiting for network or permission operations.
    activeSession.current = null;
    latestSnapshot.current = null;
    actionInFlight.current = true;
    setBusy(true);
    recordDiagnostic({ category: "party", name: "leave_requested" });
    await leavePartySession(session);
    if (!mounted.current) return;
    setSession(null);
    setSnapshot(null);
    setConnectionState("disconnected");
    setStatus("");
    actionInFlight.current = false;
    setBusy(false);
    clearDiagnosticContext();
  }, [session]);

  const retryConnection = useCallback(async () => {
    if (!session || snapshot || activeSession.current !== session || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setConnectionState("connecting");
    setStatus("Trying to reconnect…");
    recordDiagnostic({ category: "interaction", name: "session_retry_pressed" });
    try {
      const next = await fetchSnapshot(session);
      if (!mounted.current || activeSession.current !== session) return;
      applySnapshot(next, session);
      setStatus("Party restored.");
    } catch (error) {
      if (!mounted.current || activeSession.current !== session) return;
      recordDiagnosticError("lifecycle", "session_retry_failed", error);
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 404)) {
        await clearLocalParty("This party is no longer available. Create or join another party.");
        return;
      }
      setConnectionState("retrying");
      setStatus(error instanceof Error ? error.message : "Could not reconnect. Check the network and try again.");
    } finally {
      if (activeSession.current === session) {
        actionInFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }, [applySnapshot, clearLocalParty, session, snapshot]);

  const forgetParty = useCallback(async () => {
    if (!session || activeSession.current !== session) return;
    recordDiagnostic({ category: "interaction", name: "saved_session_discarded" });
    setBusy(true);
    await clearLocalParty("Saved party removed. Create or join a party to continue.");
  }, [clearLocalParty, session]);

  const exportDiagnostics = useCallback(async () => {
    if (!session || activeSession.current !== session || !snapshot || snapshot.hostId !== snapshot.selfId
      || (snapshot.phase !== "lobby" && snapshot.phase !== "finished")) return;
    setExportingDiagnostics(true);
    try {
      const result = await exportDiagnosticsFile(session, snapshot.matchId);
      if (mounted.current && activeSession.current === session) {
        setStatus(result.disposition === "saved"
          ? `Saved ${result.count} diagnostic events as ${result.fileName}.`
          : `Prepared ${result.count} diagnostic events. Use the system sheet to save or share ${result.fileName}.`);
      }
    } catch (error) {
      recordDiagnosticError("diagnostics", "export_failed", error, { matchId: snapshot.matchId });
      if (mounted.current && activeSession.current === session) setStatus(error instanceof Error ? error.message : "Diagnostics export failed.");
    } finally {
      setExportingDiagnostics(false);
    }
  }, [session, snapshot]);

  return {
    session,
    snapshot,
    status,
    busy,
    connectionState,
    exportingDiagnostics,
    create,
    join,
    command,
    leave,
    retryConnection,
    forgetParty,
    exportDiagnostics,
  };
}
