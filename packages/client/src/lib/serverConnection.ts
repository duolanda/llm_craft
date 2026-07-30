export const API_BASE_URL = "";

const webSocketUrl = new URL("/ws", window.location.href);
webSocketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

export const WS_URL = webSocketUrl.toString();
