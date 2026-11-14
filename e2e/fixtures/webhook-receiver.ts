import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

/*
 * A webhook receiver on this machine for alert channel specs (#153, #256): it answers 204 to every
 * request and keeps each one's headers and body, in order. A plain http URL on 127.0.0.1 is a
 * private address: the dev server allows it, and CI's production build sets
 * STACKDASH_ALLOW_PRIVATE_WEBHOOKS=1.
 */

export type Received = { headers: IncomingHttpHeaders; body: string };

export type WebhookReceiver = Readonly<{ server: Server; url: string; received: Received[] }>;

export async function startReceiver(): Promise<WebhookReceiver> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(204).end();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the receiver has no TCP address");
  return { server, url: `http://127.0.0.1:${address.port}/stackdash`, received };
}

export async function stopReceiver(server: Server): Promise<void> {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
}
