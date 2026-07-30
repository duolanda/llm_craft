export const MAX_WEBSOCKET_BUFFERED_BYTES = 1_000_000;

/**
 * Full state frames are replaceable projections. When a client is slow, defer
 * the send and let the next sweep build only the newest state instead of
 * extending the socket queue with obsolete frames.
 */
export function shouldDeferLatestProjection(
  bufferedAmount: number,
  limit = MAX_WEBSOCKET_BUFFERED_BYTES,
): boolean {
  return !Number.isFinite(bufferedAmount) || bufferedAmount >= limit;
}
