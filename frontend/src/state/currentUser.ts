import { useCallback, useEffect, useState } from "react";
import { ApiError, createUser, getUser } from "../api-client/client";
import { onSessionInvalid } from "./sessionEvents";

// Phase 10: a localStorage-backed stand-in for real user identity/sessions
// (see api/users.routes.ts's doc comment -- this is a stopgap real auth will
// replace, not extend). A plain hook, not Context: only one screen consumes
// this so far, and reaching for Context before more than one place needs it
// would be an abstraction this phase doesn't need yet.
//
// Phase 16 item 7: real auth will swap this hook's internals (a token/session
// lookup instead of a localStorage id, a real "is this session still valid"
// check instead of GET /users/:id) without the rest of the app needing to
// change -- every screen already only ever sees `user`/`currentUserId`, never
// the storage mechanism itself.
const STORAGE_KEY = "transcript-agent:currentUser";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
}

function readStoredUser(): CurrentUser | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CurrentUser;
  } catch {
    return null;
  }
}

export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(() => readStoredUser());
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 16 item 7: distinguishes "your stored session turned out to be
  // gone" from a plain first-time visit -- the Welkom screen shows a
  // "je sessie is verlopen" notice for the former and nothing for the latter.
  const [sessionExpired, setSessionExpired] = useState(false);

  // Lets someone switch identity without clearing all of localStorage --
  // deliberately named "forget", not "logout": there is no session to end.
  const forget = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  // Mid-session recovery: any API call anywhere in the app that comes back
  // USER_SESSION_INVALID (api-client/client.ts's apiFetch, e.g. because a
  // workflow/upload/review action hit a foreign key referencing a user that
  // no longer exists) notifies here, clears the stale session, and shows a
  // clear "session expired" message instead of the generic error the
  // triggering screen would otherwise have shown.
  useEffect(() => onSessionInvalid(() => {
    forget();
    setSessionExpired(true);
  }), [forget]);

  // App-load validation: confirms a remembered user still exists server-side
  // before the rest of the app trusts it for anything (Phase 16 item 7,
  // "geen directe afhankelijkheid van oude localStorage ID"). Silent on
  // failure -- a stale session found this way just quietly returns to the
  // Welkom screen, with no error banner (unlike the mid-session case above,
  // which the user is actively in the middle of something for).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getUser(user.id).catch((err) => {
      if (!cancelled && err instanceof ApiError && err.status === 404) {
        forget();
      }
    });
    return () => {
      cancelled = true;
    };
    // Re-validate only when the signed-in user actually changes, not on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const register = useCallback(async (name: string, email: string) => {
    setRegistering(true);
    setError(null);
    setSessionExpired(false);
    try {
      const created = await createUser({ name, email });
      const resolved: CurrentUser = { id: created.id, name: created.name, email: created.email };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(resolved));
      setUser(resolved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout");
    } finally {
      setRegistering(false);
    }
  }, []);

  return { user, registering, error, sessionExpired, register, forget };
}
