export type PlayerStateName = "idle" | "playing" | "paused";
export type OccupancyAction = "pause" | "resume" | "none";

/**
 * Convert a channel client-list length into the number of *other* users, or
 * `null` when occupancy can't be determined.
 *
 * A connected bot is always a member of its own channel, so a valid query
 * returns at least 1 (the bot itself). A length of 0 therefore does NOT mean
 * "empty channel" — it means the underlying `clientlist` query failed (e.g. the
 * full-client `clientlist` command times out when other clients are present,
 * and `getClientsInChannel()` returns `[]` on error). Treating that failure as
 * "empty" is what caused playback to auto-pause within seconds whenever a
 * listener was actually in the channel. When the result is indeterminate we
 * return `null` so callers skip the auto-pause/idle decision entirely rather
 * than mis-reading an unknown state as empty.
 */
export function occupancyFromClientList(clientCount: number): number | null {
  if (clientCount <= 0) return null; // query failed → occupancy unknown
  return clientCount - 1; // exclude the bot itself
}

/**
 * Decide what auto-pause should do given channel occupancy.
 * - empty (userCount <= 0): pause iff enabled and currently playing.
 * - re-populated (userCount > 0): resume iff we previously auto-paused and are still paused.
 * `autoPaused` distinguishes our auto-pause from a user pause, so user pauses are never resumed.
 */
export function decideOccupancyAction(
  playerState: PlayerStateName,
  autoPaused: boolean,
  enabled: boolean,
  userCount: number,
): OccupancyAction {
  const empty = userCount <= 0;
  if (empty) {
    if (enabled && playerState === "playing") return "pause";
    return "none";
  }
  if (autoPaused && playerState === "paused") return "resume";
  return "none";
}

/**
 * Whether a confirmed arrival in the bot's channel should resume playback.
 * An arrival does not resume a pause requested manually.
 */
export function shouldResumeOnReturn(
  autoPaused: boolean,
  playerState: PlayerStateName,
): boolean {
  return autoPaused && playerState === "paused";
}
