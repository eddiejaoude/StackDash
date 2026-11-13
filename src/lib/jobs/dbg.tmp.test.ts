import { it } from "vitest";
import { simulatedAdapters, simulatedAdaptersAtVolume } from "@/lib/adapters/simulated";
import { simulatedCredentialMetadata, SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { Secret } from "@/lib/adapters/types";
it("dbg", async () => {
  const NOW = new Date("2026-11-04T21:30:00.000Z");
  const cred = { accessToken: new Secret("x"), scopes: [SIMULATED_SCOPE], tokenType: "bearer", metadata: simulatedCredentialMetadata("5eed0a11") };
  for (const v of [1, 10]) {
    const ads = v === 1 ? simulatedAdapters : simulatedAdaptersAtVolume(v);
    for (const id of ["vercel", "github", "stripe", "resend", "sentry"] as const) {
      const ctx = { now: () => NOW, logger: { info() {}, warn() {}, error() {} } } as never;
      const accts = await ads[id].listAccounts(cred, ctx);
      const r = await ads[id].sync({ credential: cred, externalAccountId: accts[0]!.externalId }, ctx);
      console.log(v, id, accts.length, r.events.length);
    }
  }
});
