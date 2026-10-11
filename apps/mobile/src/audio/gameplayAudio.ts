import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { recordDiagnostic, recordDiagnosticError } from "../diagnostics";
import type { GameplaySoundKind } from "./gameplaySoundEvents";

const sources: Record<GameplaySoundKind, number> = {
  tagged: require("../../assets/audio/tagged.wav"),
  bear_trap: require("../../assets/audio/bear-trap.wav"),
};

const players = new Map<GameplaySoundKind, ReturnType<typeof createAudioPlayer>>();
let audioModePromise: Promise<void> | undefined;

function playerFor(kind: GameplaySoundKind): ReturnType<typeof createAudioPlayer> {
  const existing = players.get(kind);
  if (existing) return existing;
  const player = createAudioPlayer(sources[kind], { keepAudioSessionActive: true });
  player.volume = 1;
  players.set(kind, player);
  return player;
}

export function initializeGameplayAudio(): Promise<void> {
  audioModePromise ??= setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    shouldRouteThroughEarpiece: false,
    interruptionMode: "duckOthers",
  }).catch((error) => {
    audioModePromise = undefined;
    recordDiagnosticError("audio", "gameplay_audio_setup_failed", error);
    throw error;
  });
  return audioModePromise;
}

export async function playGameplaySound(kind: GameplaySoundKind, eventId: string): Promise<boolean> {
  try {
    await initializeGameplayAudio();
    for (const player of players.values()) {
      if (player.playing) player.pause();
    }
    const player = playerFor(kind);
    if (player.currentTime > 0) await player.seekTo(0);
    player.play();
    recordDiagnostic({
      category: "audio",
      name: "gameplay_sound_started",
      correlationId: eventId,
      payload: { kind },
    });
    return true;
  } catch (error) {
    recordDiagnosticError("audio", "gameplay_sound_failed", error, { kind, eventId });
    return false;
  }
}
