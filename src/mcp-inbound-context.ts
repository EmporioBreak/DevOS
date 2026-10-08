import { AsyncLocalStorage } from "node:async_hooks";

type HeaderBag = Record<string, string | string[] | undefined>;

const inbound = new AsyncLocalStorage<HeaderBag>();

export function withInboundMcpHeaders<T>(
  headers: HeaderBag,
  run: () => T,
): T {
  return inbound.run(headers, run);
}

export function inboundMcpHeaders(): HeaderBag | undefined {
  return inbound.getStore();
}
