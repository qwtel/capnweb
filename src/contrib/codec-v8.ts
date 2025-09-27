// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { Codec, TypeForRpc, WireMessage } from "../codec.js";
import * as v8 from "node:v8";
import { typeForRpc } from "../core.js";

export class V8Codec implements Codec {
  name: "v8" = "v8";

  encode(message: any): WireMessage {
    const ab = v8.serialize(message);
    return ab instanceof Uint8Array ? ab : new Uint8Array(ab);
  }

  decode(wire: WireMessage): any {
    if (typeof wire === "string") {
      console.log(wire)
      throw new TypeError("V8Codec.decode expected ArrayBuffer or Uint8Array wire payload");
    }
    // Ensure we pass an ArrayBufferView when necessary
    const view = wire instanceof Uint8Array ? wire : new Uint8Array(wire);
    // @ts-ignore: v8 typings differ across Node versions
    return v8.deserialize(view);
  }

  typeForRpc(value: unknown): TypeForRpc {
    // Start with base classification.
    const base = typeForRpc(value);
    if (base !== "unsupported") {
      // In v8 mode, treat some special JSON encodings as primitives to avoid tagging.
      switch (base) {
        case "bigint":
        case "date":
        case "bytes":
        case "undefined":
          return "raw";
        // Intentionally keep "error" as "error" so the devaluator can apply onSendError rewrite.
      }
      return base;
    }

    // In v8 mode, many structured-cloneable values can be passed directly.
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

        if (value instanceof Error) {
          console.log("Heyooo")
          return "error-raw";
        }
      }
    } catch (_err) {
      // Fall through to unsupported
    }

    return base;
  }
}

export const V8_CODEC = new V8Codec();
