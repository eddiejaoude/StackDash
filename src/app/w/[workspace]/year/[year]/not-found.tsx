import { connection } from "next/server";

import { ItemNotFound } from "@/components/app/item-not-found";
import { latestCardYear } from "@/lib/public-metrics/yearly";

// The newest year with a year in review, by the server's clock: the clock the page itself checks the
// year against (`parseCardYear`), so the link always opens a year that exists. `connection()` keeps
// the clock out of prerendering, and the promise is never awaited here, so nothing waits on it.
async function latestYear(): Promise<number> {
  await connection();
  return latestCardYear(new Date());
}

export default function YearNotFound() {
  return <ItemNotFound item="year" latestYear={latestYear()} />;
}
