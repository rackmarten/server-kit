import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

// Keyword search: an app stores a `keywords` tsvector
// built from a few text fields, normalized here in JS rather than in
// Postgres because `unaccent` can't be used in a generated column. The same
// normalization is applied to the search term, so "ulohy popis" finds
// "Popis úlohy".

/**
 * Lowercased, diacritic-free, deduped words of `text`. Anything that isn't a
 * letter or digit (`-`, `_`, punctuation, whitespace) separates words, so
 * the query side never has to escape tsquery syntax.
 */
export const normalizeWords = (text: string): string[] => {
  const words = text
    .normalize("NFD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return [...new Set(words)];
};

/**
 * The normalized keyword string for `record`'s `fields` (missing or null
 * fields are skipped). Store it as `to_tsvector('simple', <this>)`, e.g. via
 * `keywordsVector`, on every insert and on any update touching those fields.
 */
export const buildKeywords = <T extends object>(
  record: T,
  fields: readonly (keyof T)[],
): string => {
  const text = fields
    .map((field) => record[field])
    .filter((value: unknown) => value !== null && value !== undefined)
    .join(" ");
  return normalizeWords(text).join(" ");
};

/** `to_tsvector('simple', …)` of `buildKeywords(record, fields)`, for insert/update values. */
export const keywordsVector = <T extends object>(record: T, fields: readonly (keyof T)[]): SQL =>
  sql`to_tsvector('simple', ${buildKeywords(record, fields)})`;

/**
 * The tsquery text for `term`: every typed word must prefix-match some
 * keyword, in any order (`'a':* & 'b':*`). Null when the term has no words.
 */
export const keywordQuery = (term: string): string | null => {
  const words = normalizeWords(term);
  if (words.length === 0) return null;
  // Words are only letters and digits, so quoting is belt and braces.
  return words.map((word) => `'${word.replaceAll("'", "''")}':*`).join(" & ");
};

/**
 * WHERE condition matching `column` (a tsvector built by `keywordsVector`)
 * against `term`, or undefined when the term has no words (drizzle's
 * `and()` drops undefined). Indexable with a GIN index on the column.
 */
export const keywordSearch = (column: PgColumn | SQL, term: string): SQL | undefined => {
  const query = keywordQuery(term);
  return query === null ? undefined : sql`${column} @@ to_tsquery('simple', ${query})`;
};
