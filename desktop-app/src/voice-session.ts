export function formatVoiceDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function voiceStartedAtFromElapsed(nowMs: number, elapsedSeconds: unknown) {
  const elapsed = Number(elapsedSeconds);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return nowMs - Math.floor(elapsed) * 1000;
}

export function resolveCallFocus<T extends { id: number }>(users: T[], requestedId: number | null) {
  if (users.length < 2 || requestedId === null) return null;
  return users.some((user) => user.id === requestedId) ? requestedId : null;
}
