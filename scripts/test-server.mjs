/// <reference types="node" />
import { startServer } from "./index.js";
import { Game } from "../Game.js";
import { ControlSessionManager } from "../ControlHandler.js";

// Start the real server on port 3001
const { server, wss, state } = startServer();

// Wait a tick for server to boot
setTimeout(() => {
  // Create a game and inject it into the orchestrator
  const game = new Game();
  game.start();

  // The orchestrator needs to be set so control routes can find it
  (state as any).orchestrator = {
    getGame() {
      return game;
    },
    stop() {},
    start() {},
    saveRecord() { return Promise.resolve(""); },
    getState() { return game.getState(); },
    getSnapshots() { return []; },
    getLatestSnapshot() { return null; },
  };

  console.log("Game injected into server. Ready for CLI testing.");
}, 1000);
