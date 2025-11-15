import { Codec, isRawSubtreeBranded, JSON_CODEC, WireMessage } from "./codec.js";
import { TypeForRpc } from "./core.js";
import { RawFeatures } from "./serialize.js";
import { RAW_SUBTREE_BRAND } from "./symbols.js";

export class PostMessageCodec implements Codec {
  readonly name = "postmessage";

  encode(message: any): WireMessage {
    return message;
  }

  decode(wire: WireMessage): any {
    return wire;
  }

  typeForRpc(value: unknown): TypeForRpc {
    // Start with base classification.
    const base = JSON_CODEC.typeForRpc(value);
    if (base !== "unsupported") {
      // In object mode, treat some special JSON encodings as primitives to avoid tagging.
      switch (base) {
        case "primitive":
        case "bigint":
        case "date":
        case "bytes":
        case "undefined":
          return "raw";
        case "error":
          return "error-raw";
        default:
          return base;
      }
    }

    // In object mode, many structured-cloneable values can be passed directly.
    // Treat them as primitives (raw) for purposes of devaluation (pass-through).
    try {
      if (typeof value === "object" && value !== null) {
        if (isRawSubtreeBranded(value) && value[RAW_SUBTREE_BRAND] <= RawFeatures.StructuredClone) {
          return "raw-subtree";
        }

        if (ArrayBuffer.isView(value)) {
          return "raw";
        }

        if (value instanceof ArrayBuffer) {
          return "raw";
        }

        if (value instanceof Map || value instanceof Set) {
        return "raw";
      }

        if (value instanceof RegExp) {
          return "raw";
        }
      }
    } catch (_err) {
      // Fall through to unsupported
    }

    return base;
  }
}

export const POSTMESSAGE_CODEC = new PostMessageCodec();
