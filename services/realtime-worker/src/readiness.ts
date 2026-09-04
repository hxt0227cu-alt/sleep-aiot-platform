export interface WorkerReadinessState {
  groupJoined: boolean;
  processingBlocked: boolean;
  shuttingDown: boolean;
}

export function isWorkerReady(state: WorkerReadinessState) {
  return state.groupJoined && !state.processingBlocked && !state.shuttingDown;
}
