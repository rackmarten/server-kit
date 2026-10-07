import type { HomelabUser } from "../auth/types.js";

// Per-resource ownership and sharing. Who owns what
// lives in each app's own database, never in the token; the token only says
// who is asking (id, groups, roles). Convention for an owned table:
//
//   owner_id     person id of the owner
//   visibility   'private' (owner only) or 'shared'
//   shared_with  principals it is shared with: `person:<id>` / `group:<id>`
//
// Postgres apps spread ownershipColumns() into their Drizzle table and filter
// lists with visibleTo(); SQLite apps use the plain-SQL variant in
// sqlite.ts. Per-row checks use canSee/canUse below.
//
// Rules: an admin sees and uses everything. Otherwise the owner does, and
// while visibility is 'shared', so does every person or group member listed
// in shared_with, with full use (decided 2026-09-26). A share list kept on a
// private resource is ignored, so switching back and forth keeps it. Deleting
// or re-sharing is the app's call; `isOwner` is there for that.

export type Visibility = "private" | "shared";

export interface Owned {
  ownerId: string;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- documents the known values while still accepting any stored string (public type)
  visibility: Visibility | string;
  sharedWith?: readonly string[] | null;
}

export const principal = {
  person: (id: string): string => `person:${id}`,
  group: (id: string): string => `group:${id}`,
};

// Everything a share list can name that matches this user.
export const principalsOf = (user: HomelabUser): string[] => [
  principal.person(user.id),
  ...user.groups.map((groupId) => principal.group(groupId)),
];

export const isAdmin = (user: HomelabUser | null | undefined): boolean =>
  Boolean(user?.roles.includes("admin"));

export const isOwner = (user: HomelabUser | null | undefined, resource: Owned): boolean =>
  user ? resource.ownerId === user.id : false;

export const canSee = (user: HomelabUser | null | undefined, resource: Owned): boolean => {
  if (!user) return false;
  if (isAdmin(user) || isOwner(user, resource)) return true;
  if (resource.visibility !== "shared") return false;
  const mine = new Set(principalsOf(user));
  return (resource.sharedWith ?? []).some((entry) => mine.has(entry));
};

// Same people as canSee (shared means full use), except that a view-as
// request is read-only, so it can never use anything.
export const canUse = (user: HomelabUser | null | undefined, resource: Owned): boolean => {
  if (!user || user.actor) return false;
  return canSee(user, resource);
};
