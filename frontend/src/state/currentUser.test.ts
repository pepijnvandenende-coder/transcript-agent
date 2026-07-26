import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../api-client/client";
import { useCurrentUser } from "./currentUser";

const STORAGE_KEY = "transcript-agent:currentUser";

describe("state/currentUser", () => {
  beforeEach(() => {
    localStorage.clear();
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
});
