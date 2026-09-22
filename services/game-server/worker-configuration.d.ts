interface Env {
  GAME_ROOMS: DurableObjectNamespace<import("./src/room").GameRoom>;
}
