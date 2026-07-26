import { useCallback, useState } from "react";
import { createUser } from "../api-client/client";

// Phase 10: a localStorage-backed stand-in for real user identity/sessions
// (see api/users.routes.ts's doc comment -- this is a stopgap real auth will
// replace, not extend). A plain hook, not Context: only one screen consumes
// this so far, and reaching for Context before more than one place needs it
// would be an abstraction this phase doesn't need yet.
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

  const register = useCallback(async (name: string, email: string) => {
    setRegistering(true);
    setError(null);
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

  // Lets someone switch identity without clearing all of localStorage --
  // deliberately named "forget", not "logout": there is no session to end.
  const forget = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  return { user, registering, error, register, forget };
}
