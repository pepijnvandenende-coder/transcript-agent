import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api-client/client";
import * as client from "../api-client/client";
import { useCurrentUser } from "./currentUser";
import { notifySessionInvalid } from "./sessionEvents";

const STORAGE_KEY = "transcript-agent:currentUser";

describe("state/currentUser", () => {
  beforeEach(() => {
    localStorage.clear();
    // Default: the app-load validation effect (getUser) succeeds, so tests
    // that don't care about it don't need their own mock.
    vi.spyOn(client, "getUser").mockResolvedValue({ id: "u1", name: "Jan", email: "jan@example.com", role: "member" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with no user when localStorage is empty", () => {
    const { result } = renderHook(() => useCurrentUser());
    expect(result.current.user).toBeNull();
  });

  it("register() creates the user, stores it, and updates state", async () => {
    vi.spyOn(client, "createUser").mockResolvedValue({ id: "u1", name: "Jan", email: "jan@example.com", role: "member" });

    const { result } = renderHook(() => useCurrentUser());

    await act(async () => {
      await result.current.register("Jan", "jan@example.com");
    });

    expect(result.current.user).toEqual({ id: "u1", name: "Jan", email: "jan@example.com" });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ id: "u1", name: "Jan", email: "jan@example.com" });
  });

  it("a fresh hook instance reads an already-stored user without calling createUser", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: "u1", name: "Jan", email: "jan@example.com" }));
    const createUserSpy = vi.spyOn(client, "createUser");

    const { result } = renderHook(() => useCurrentUser());

    expect(result.current.user).toEqual({ id: "u1", name: "Jan", email: "jan@example.com" });
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it("forget() clears localStorage and resets user to null", async () => {
    vi.spyOn(client, "createUser").mockResolvedValue({ id: "u1", name: "Jan", email: "jan@example.com", role: "member" });
    const { result } = renderHook(() => useCurrentUser());
    await act(async () => {
      await result.current.register("Jan", "jan@example.com");
    });

    act(() => {
      result.current.forget();
    });

    expect(result.current.user).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("register() failure sets an error message and leaves user null", async () => {
    vi.spyOn(client, "createUser").mockRejectedValue(new Error("Netwerkfout"));

    const { result } = renderHook(() => useCurrentUser());
    await act(async () => {
      await result.current.register("Jan", "jan@example.com");
    });

    expect(result.current.user).toBeNull();
    expect(result.current.error).toBe("Netwerkfout");
  });

  // Phase 16 item 7: at app load, a remembered user that no longer exists
  // server-side (e.g. test data was cleaned up) must be dropped silently --
  // no error banner, just a return to the "Wie ben je?" / Welkom screen.
  describe("app-load validation (GET /users/:id)", () => {
    it("keeps the stored user when the backend confirms it still exists", async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: "u1", name: "Jan", email: "jan@example.com" }));
      vi.spyOn(client, "getUser").mockResolvedValue({ id: "u1", name: "Jan", email: "jan@example.com", role: "member" });

      const { result } = renderHook(() => useCurrentUser());

      await waitFor(() => expect(client.getUser).toHaveBeenCalledWith("u1"));
      expect(result.current.user).toEqual({ id: "u1", name: "Jan", email: "jan@example.com" });
    });

    it("silently clears a stored user the backend no longer knows about, with no error and no session-expired notice", async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: "gone", name: "Jan", email: "jan@example.com" }));
      vi.spyOn(client, "getUser").mockRejectedValue(new ApiError(404, "User not found"));

      const { result } = renderHook(() => useCurrentUser());

      await waitFor(() => expect(result.current.user).toBeNull());
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.sessionExpired).toBe(false);
    });
  });

  // Phase 16 item 7: mid-session, any API call anywhere that comes back
  // USER_SESSION_INVALID (api-client/client.ts's apiFetch, on a Prisma
  // foreign-key failure) must clear the session and show a clear "session
  // expired" message -- not the generic "Er is een fout opgetreden."
  describe("mid-session recovery (USER_SESSION_INVALID)", () => {
    it("clears the user and sets sessionExpired when notifySessionInvalid fires", async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: "u1", name: "Jan", email: "jan@example.com" }));

      const { result } = renderHook(() => useCurrentUser());
      await waitFor(() => expect(result.current.user).not.toBeNull());

      act(() => {
        notifySessionInvalid();
      });

      expect(result.current.user).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(result.current.sessionExpired).toBe(true);
    });

    it("register() after a session-expired notice clears sessionExpired again", async () => {
      vi.spyOn(client, "createUser").mockResolvedValue({ id: "u2", name: "Marieke", email: "marieke@example.com", role: "member" });

      const { result } = renderHook(() => useCurrentUser());
      act(() => {
        notifySessionInvalid();
      });
      expect(result.current.sessionExpired).toBe(true);

      await act(async () => {
        await result.current.register("Marieke", "marieke@example.com");
      });

      expect(result.current.sessionExpired).toBe(false);
      expect(result.current.user).toEqual({ id: "u2", name: "Marieke", email: "marieke@example.com" });
    });
  });
});
