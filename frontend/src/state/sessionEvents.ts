// Phase 16 item 7: a tiny pub-sub so api-client/client.ts (not a React
// component, has no access to app state) can tell state/currentUser.ts's
// hook "the stored user is gone, recover" the moment any request anywhere in
// the app comes back with USER_SESSION_INVALID -- without introducing
// Context or a state library for what is, so far, exactly one event. A
// single listener slot is enough: only one useCurrentUser() instance is ever
// mounted (App.tsx renders it once, at the root).
type Listener = () => void;

let listener: Listener | null = null;

export function onSessionInvalid(callback: Listener): () => void {
  listener = callback;
  return () => {
    if (listener === callback) listener = null;
  };
}

export function notifySessionInvalid(): void {
  listener?.();
}
