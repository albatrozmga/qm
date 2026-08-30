import type { SessionStore } from "./session-store.ts";

// ponytail: prazo fixo; vira env/config se algum dia houver demanda real.
export const PURGE_AFTER_MS = 30 * 24 * 3600 * 1000;
const SWEEP_INTERVAL_MS = 24 * 3600 * 1000;

export async function sweepDeletedSessions(sessions: SessionStore, now: number): Promise<number> {
  let purged = 0;
  for (const id of await sessions.listDeletedBefore(now - PURGE_AFTER_MS)) {
    try {
      await sessions.deleteSession(id);
      purged++;
    } catch (e) {
      console.error(`[deleted-session-sweeper] failed to purge ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return purged;
}

export function startDeletedSessionSweeper(sessions: SessionStore): () => void {
  const run = () => void sweepDeletedSessions(sessions, Date.now());
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
