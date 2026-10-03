import type { AdapterEvent, CodexParsedRequest } from "../types";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  abortSignal?: AbortSignal;
}

export interface ProviderAdapter {
  name: string;
  /** Validate request-specific execution authority before an HTTP response stream is opened. */
  prepareTurn?(parsed: CodexParsedRequest, incoming: IncomingMeta): Promise<void> | void;
  runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}
