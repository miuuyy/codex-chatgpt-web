import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";

const MAX_ENCODED_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_REQUEST_BYTES = 128 * 1024 * 1024;

function assertWithinLimit(bytes: number, limit: number, label: string): void {
  if (bytes > limit) throw new Error(`${label} exceeds ${limit} bytes`);
}

export async function readJsonRequestBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength)) {
    assertWithinLimit(declaredLength, MAX_ENCODED_REQUEST_BYTES, "Encoded request body");
  }

  const encoded = new Uint8Array(await request.arrayBuffer());
  assertWithinLimit(encoded.byteLength, MAX_ENCODED_REQUEST_BYTES, "Encoded request body");

  const contentEncoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  let decoded: Uint8Array;
  if (contentEncoding === "" || contentEncoding === "identity") {
    decoded = encoded;
  } else if (contentEncoding === "zstd") {
    decoded = typeof Bun !== "undefined"
      ? await Bun.zstdDecompress(encoded)
      : new Uint8Array(await promisify(zstdDecompress)(encoded));
  } else {
    throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
  }
  assertWithinLimit(decoded.byteLength, MAX_DECODED_REQUEST_BYTES, "Decoded request body");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  return JSON.parse(text) as unknown;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function encodeJsonRequestBody(value: unknown, contentEncoding: string): Promise<ArrayBuffer> {
  const decoded = new TextEncoder().encode(JSON.stringify(value));
  assertWithinLimit(decoded.byteLength, MAX_DECODED_REQUEST_BYTES, "Decoded request body");

  const normalized = contentEncoding.trim().toLowerCase();
  if (normalized === "" || normalized === "identity") return exactArrayBuffer(decoded);
  if (normalized === "zstd") {
    const encoded = typeof Bun !== "undefined"
      ? await Bun.zstdCompress(decoded)
      : new Uint8Array(await promisify(zstdCompress)(decoded));
    assertWithinLimit(encoded.byteLength, MAX_ENCODED_REQUEST_BYTES, "Encoded request body");
    return exactArrayBuffer(encoded);
  }
  throw new Error(`Unsupported Content-Encoding: ${normalized}`);
}
