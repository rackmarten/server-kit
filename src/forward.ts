// App-to-app calls on behalf of the person asking: the receiving
// app verifies the same identity token, so it sees the same person
// instead of "some service". Tokens live 5 minutes, so forward on the
// request that is being served, not from a background job much later.

// Headers carrying `token` to another app. `Authorization: Bearer` by
// default; when the call already uses Authorization for something else
// (an inference gateway's API key), X-Homelab-Token instead. server-kit's jwt strategy
// accepts both.
export const forwardTokenHeaders = (
  token: string | null | undefined,
  existing?: HeadersInit,
): Record<string, string> => {
  if (!token) return {};
  const isTaken = new Headers(existing).has("authorization");
  return isTaken ? { "x-homelab-token": token } : { authorization: `Bearer ${token}` };
};

// fetch() with the caller's token attached. Pass the Fastify request (or
// anything with `homelabToken`) being served.
export const homelabFetch = (
  caller: { homelabToken?: string | null } | null | undefined,
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(
    forwardTokenHeaders(caller?.homelabToken, init.headers),
  )) {
    headers.set(name, value);
  }
  return fetch(input, { ...init, headers });
};
