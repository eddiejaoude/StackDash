import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/*
 * Test only. A fake PostgREST that behaves like the real one on the point the paged reads depend
 * on: it answers at most `max_rows` (1000, supabase/config.toml) rows per request, whatever
 * `limit` asks for, and says nothing about the rows it left out (#209). The client is the real
 * supabase-js client with `fetch` replaced, so a store's queries are the ones it sends in
 * production. It knows the filters `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `like` (Postgres
 * `LIKE`: `_` is any one character, `%` and PostgREST's `*` any run), `is.null`, and `not.is.null`,
 * the logic filters `or` and `and` over them (a keyset page's
 * `or=(occurred_at.gt."x",and(occurred_at.eq."x",id.gt.y))`), `order` (asc or desc per column),
 * `offset`, `limit`, `select` by column name, and an exact count (`count: "exact"`, with `head` or
 * without); any other query fails as PostgREST would rather
 * than answer wrongly. A function call (`.rpc(name, args)`) is answered by the test's handler for
 * `name`, and its rows are then filtered, ordered, paged, and selected like a table's, as PostgREST
 * does with a set returning function; a handler that returns scalars (a `setof text` function) is
 * answered as the JSON array of them. Each answered request is recorded with its filters (and a
 * call's arguments), so a test can check what a read asked for, not only how many rows.
 */

export const MAX_ROWS = 1000;

export type Cell = string | number | boolean | null | readonly string[];
export type Row = Readonly<Record<string, Cell>>;
/** One filter as sent: the column and its PostgREST operator and operand, such as `["snapshot_date", "gte.2026-09-27"]`. */
export type Filter = readonly [column: string, filter: string];
/** A set returning function's rows, or a scalar function's values, for one call's JSON arguments. */
export type FunctionHandler = (args: Readonly<Record<string, unknown>>) => readonly Row[] | readonly Cell[];
/** `table` is the table name, or `rpc/<name>` for a function call, whose arguments are `args`. */
export type PageRequest = Readonly<{
  table: string;
  args: Readonly<Record<string, unknown>> | null;
  filters: readonly Filter[];
  offset: number;
  limit: number | null;
  returned: number;
}>;

async function callArgs(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Record<string, unknown>> {
  const body = input instanceof Request ? await input.text() : init?.body;
  if (typeof body !== "string" || body === "") return {};
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The fake PostgREST expects an object of function arguments");
  }
  return Object.fromEntries(Object.entries(parsed));
}

/** The values of a PostgREST `in.(...)` list; postgrest-js quotes a value only when it must. */
function inList(rest: string): Set<string> {
  const inner = rest.replace(/^\(/, "").replace(/\)$/, "");
  return new Set([...inner.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)].map((match) => match[1] ?? match[2] ?? ""));
}

/** One PostgREST filter (`eq.x`, `in.(a,b)`, `not.is.null`, ...) as a test on a cell, or null when the fake does not know it. */
function predicate(filter: string): ((value: string | null) => boolean) | null {
  if (filter === "is.null") return (value) => value === null;
  if (filter === "not.is.null") return (value) => value !== null;
  const dot = filter.indexOf(".");
  const operand = filter.slice(dot + 1);
  switch (filter.slice(0, dot)) {
    case "eq":
      return (value) => value === operand;
    case "neq":
      return (value) => value !== null && value !== operand;
    case "gt":
      return (value) => value !== null && value > operand;
    case "gte":
      return (value) => value !== null && value >= operand;
    case "lt":
      return (value) => value !== null && value < operand;
    case "lte":
      return (value) => value !== null && value <= operand;
    case "in": {
      const values = inList(operand);
      return (value) => value !== null && values.has(value);
    }
    case "like": {
      const wildcard: Readonly<Record<string, string>> = { "*": ".*", "%": ".*", _: "." };
      const pattern = new RegExp(`^${[...operand].map((char) => wildcard[char] ?? char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}$`);
      return (value) => value !== null && pattern.test(value);
    }
    default:
      return null;
  }
}

type RowTest = (row: Row) => boolean;

function columnTest(column: string, filter: string): RowTest | null {
  const test = predicate(filter);
  if (test === null) return null;
  return (row) => {
    const cell = row[column];
    return test(cell === undefined || cell === null ? null : String(cell));
  };
}

/** The terms of a logic filter's list, split at its top level commas; a quoted value stays whole. */
function logicTerms(list: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      terms.push(list.slice(start, index));
      start = index + 1;
    }
  }
  terms.push(list.slice(start));
  return terms;
}

/** One term of a logic filter (`id.gt.x`, `occurred_at.eq."x"`, or a nested `and(...)`), or null when the fake does not know it. */
function logicTermTest(term: string): RowTest | null {
  for (const operator of ["and", "or"] as const) {
    if (term.startsWith(`${operator}(`)) return logicTest(operator, term.slice(operator.length));
  }
  const [column = "", operator = "", ...rest] = term.split(".");
  const operand = rest.join(".");
  // A value postgrest-js quotes (a timestamp's `:` and `+`) is compared without its quotes.
  const unquoted = /^".*"$/.test(operand) ? operand.slice(1, -1).replace(/\\(.)/g, "$1") : operand;
  return columnTest(column, `${operator}.${unquoted}`);
}

/** A PostgREST `or` or `and` filter's parenthesized list as one row test, or null when the fake does not know a term. */
function logicTest(operator: "and" | "or", list: string): RowTest | null {
  const tests: RowTest[] = [];
  for (const term of logicTerms(list.replace(/^\(/, "").replace(/\)$/, ""))) {
    const test = logicTermTest(term);
    if (test === null) return null;
    tests.push(test);
  }
  return operator === "and" ? (row) => tests.every((test) => test(row)) : (row) => tests.some((test) => test(row));
}

function isRows(values: readonly Row[] | readonly Cell[]): values is readonly Row[] {
  return values.every((value) => typeof value === "object" && value !== null && !Array.isArray(value));
}

function compareBy(order: string): (a: Row, b: Row) => number {
  const keys = order.split(",").map((part) => {
    const [column = "", direction = "asc"] = part.split(".");
    return { column, sign: direction === "desc" ? -1 : 1 };
  });
  return (a, b) => {
    for (const { column, sign } of keys) {
      const left = String(a[column]);
      const right = String(b[column]);
      if (left !== right) return left < right ? -sign : sign;
    }
    return 0;
  };
}

const RESERVED: Readonly<Record<string, true>> = { select: true, order: true, limit: true, offset: true };

/**
 * A Supabase client over in-memory tables and set returning `functions` that, like PostgREST,
 * returns at most MAX_ROWS rows a request.
 */
export function fakeSupabase(tables: Readonly<Record<string, readonly Row[]>>, functions: Readonly<Record<string, FunctionHandler>> = {}) {
  const requests: PageRequest[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const segments = url.pathname.split("/");
    const name = segments.at(-1) ?? "";
    const isCall = segments.at(-2) === "rpc";
    const table = isCall ? `rpc/${name}` : name;
    const args = isCall ? await callArgs(input, init) : null;
    const source = isCall ? functions[name]?.(args ?? {}) : tables[name];
    const sent = [...url.searchParams].flatMap(([column, filter]): Filter[] => (RESERVED[column] === true ? [] : [[column, filter]]));
    const filters = sent.map(([column, filter]) =>
      column === "and" || column === "or" ? logicTest(column, filter) : columnTest(column, filter),
    );
    // A query the fake cannot answer fails as PostgREST would, rather than answer wrongly.
    if (source === undefined || filters.some((test) => test === null)) {
      return new Response(JSON.stringify({ message: `The fake PostgREST cannot answer ${url.search} on ${table}` }), { status: 400 });
    }
    if (!isRows(source)) {
      // A scalar function's values have no columns to filter or order by.
      if (sent.length > 0 || url.searchParams.has("order")) {
        return new Response(JSON.stringify({ message: `The fake PostgREST cannot answer ${url.search} on ${table}` }), { status: 400 });
      }
      const values = source.slice(0, MAX_ROWS);
      requests.push({ table, args, filters: sent, offset: 0, limit: null, returned: values.length });
      return new Response(JSON.stringify(values), { status: 200, headers: { "content-type": "application/json" } });
    }
    let rows = source.filter((row) => filters.every((test) => test?.(row) === true));
    // `Prefer: count=exact`: the total of the filtered rows, in the header PostgREST answers it in.
    const prefer = new Headers(input instanceof Request ? input.headers : init?.headers).get("Prefer") ?? "";
    const counted: Record<string, string> = /count=exact/.test(prefer) ? { "content-range": `*/${rows.length}` } : {};
    if ((input instanceof Request ? input.method : init?.method) === "HEAD") {
      requests.push({ table, args, filters: sent, offset: 0, limit: null, returned: 0 });
      return new Response(null, { status: 200, headers: counted });
    }
    const order = url.searchParams.get("order");
    const columns = (url.searchParams.get("select") ?? "*").split(",");
    // PostgREST orders a function's rows after selecting the columns, so it can order only by a
    // selected column (42703 otherwise, seen on #317); a table orders by any column.
    const unselected = (order ?? "")
      .split(",")
      .map((part) => part.split(".")[0] ?? "")
      .filter((column) => column !== "" && columns[0] !== "*" && !columns.includes(column));
    if (isCall && unselected.length > 0) {
      return new Response(JSON.stringify({ code: "42703", message: `column ${name}.${unselected[0]} does not exist` }), { status: 400 });
    }
    if (order !== null) rows = rows.toSorted(compareBy(order));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? null : Number(limitParam);
    // max_rows: whatever the request asked for, never more than this, and no error.
    const page = rows.slice(offset, offset + Math.min(limit ?? MAX_ROWS, MAX_ROWS));
    const body = page.map((row) => (columns[0] === "*" ? row : Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))));
    requests.push({ table, args, filters: sent, offset, limit, returned: body.length });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...counted } });
  };
  const db = createClient<Database>("http://postgrest.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fakeFetch },
  });
  return { db, requests };
}
