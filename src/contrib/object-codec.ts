// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { Codec, TypeForRpc, WireMessage } from "../codec.js";
import { typeForRpc } from "../core.js";

export class ObjectCodec implements Codec {
  readonly name: "object" = "object";

  encode(message: any): WireMessage {
    return message;
  }

  decode(wire: WireMessage): any {
    return wire;
  }

  typeForRpc(value: unknown): TypeForRpc {
    // Start with base classification.
    const base = typeForRpc(value);
    if (base !== "unsupported") {
      // In object mode, treat some special JSON encodings as primitives to avoid tagging.
      switch (base) {
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
        if (ArrayBuffer.isView(value)) {
          return "raw";
        }

        // ArrayBuffer
        if (value instanceof ArrayBuffer) {
          return "raw";
        }

        // Map / Set
        if (value instanceof Map || value instanceof Set) {
          return "raw";
        }

        // RegExp
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

export const OBJECT_CODEC = new ObjectCodec();
