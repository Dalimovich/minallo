export interface StreamRecoveryState {
  started: boolean;
}

interface CancelableReader {
  cancel(): Promise<unknown>;
}

/** Atomically claim stream recovery and stop all remaining token delivery. */
export function beginSafeStreamRecovery(
  state: StreamRecoveryState,
  reader: CancelableReader | null,
  controller: AbortController,
): boolean {
  if (state.started) return false;
  state.started = true;
  void reader?.cancel().catch(() => undefined);
  controller.abort();
  return true;
}
