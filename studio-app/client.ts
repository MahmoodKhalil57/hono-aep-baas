import { aepClient } from "hono-aep/client";

/**
 * The one /v1 client. Bearer-aware (spec/interface.md): a per-project
 * interface owned by a POOL principal (a nested child) authenticates with
 * the child's key/token, stored per project path; the platform console
 * (top-level, owned by a platform account) just uses the same-origin
 * cookie. authFetch adds Authorization when a token is present — so both
 * flows work through one client, and get-session/sign-in use it too.
 */
const TOKEN_KEY = "interface.token";
export const token = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (value: string | null): void => {
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
};

export const authFetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
  const t = token();
  if (!t) return fetch(input, init);
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("Authorization", `Bearer ${t}`);
  return fetch(input, { ...init, headers });
}) as typeof fetch;

export const v1 = aepClient({ base: "/v1", fetch: authFetch });
