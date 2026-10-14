export interface ReachabilityState {
  isConnected?: boolean;
  isInternetReachable?: boolean;
}

export interface ReachabilityObservation {
  wasUnavailable: boolean;
  recovered: boolean;
}

/** Only a known offline-to-online transition should trigger active recovery. */
export function observeReachability(
  wasUnavailable: boolean,
  state: ReachabilityState,
): ReachabilityObservation {
  const unavailable = state.isConnected === false || state.isInternetReachable === false;
  const reachable = state.isConnected === true && state.isInternetReachable !== false;
  if (unavailable) return { wasUnavailable: true, recovered: false };
  if (reachable && wasUnavailable) return { wasUnavailable: false, recovered: true };
  return { wasUnavailable, recovered: false };
}
