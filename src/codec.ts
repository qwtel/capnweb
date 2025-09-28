// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcStub, RpcPromise } from "./core.js";

export type WireMessage = string | Uint8Array | ArrayBuffer;

export let workersModuleName = navigator.userAgent === "Cloudflare-Workers" ? "cloudflare:workers" : null;
let workersModule: any;
if (workersModuleName) {
  workersModule = await import(/* @vite-ignore */workersModuleName);
}

export let RpcTarget = workersModule ? workersModule.RpcTarget : class {};

export type TypeForRpc = "unsupported" | "primitive"  | "object" | "function" | "array" | "date" |
    "bigint" | "bytes" | "stub" | "rpc-promise" | "rpc-target" | "rpc-thenable" | "error" |
    "error-raw" | "undefined" | "raw";

export interface Codec {
  // Encode a JSON-serializable message tree (RPC expression) to a wire payload.
  encode(message: any): WireMessage;

  // Decode a wire payload into a JSON-serializable message tree (RPC expression).
  decode(wire: WireMessage): any;

  // Indicates which value-level codec semantics apply for devaluation/evaluation.
  // - "json": values use tagged arrays and base64 bytes
  // - "v8":   values are structured-clone-friendly and typed
  name: "json" | "v8";

  // Classify a value for RPC serialization semantics under this codec.
  // This governs what the devaluator treats as pass-through vs needs tagging.
  typeForRpc(value: unknown): TypeForRpc;
}

export class JsonCodec implements Codec {
  name: "json" = "json";

  encode(message: any): WireMessage {
    return JSON.stringify(message);
  }

  decode(wire: WireMessage): any {
    if (typeof wire !== "string") {
      throw new TypeError("JsonCodec.decode expected string wire payload");
    }
    return JSON.parse(wire);
  }

  typeForRpc(value: unknown): TypeForRpc {
    switch (typeof value) {
      case "boolean":
      case "number":
      case "string":
        return "primitive";

      case "undefined":
        return "undefined";

      case "object":
      case "function":
        // Test by prototype, below.
        break;

      case "bigint":
        return "bigint";

      default:
        return "unsupported";
    }

    // Ugh JavaScript, why is `typeof null` equal to "object" but null isn't otherwise anything like
    // an object?
    if (value === null) {
      return "primitive";
    }

    // Aside from RpcTarget, we generally don't support serializing *subclasses* of serializable
    // types, so we switch on the exact prototype rather than use `instanceof` here.
    let prototype = Object.getPrototypeOf(value);
    switch (prototype) {
      case Object.prototype:
        return "object";

      case Function.prototype:
        return "function";

      case Array.prototype:
        return "array";

      case Date.prototype:
        return "date";

      case Uint8Array.prototype:
        return "bytes";

      // TODO: All other structured clone types.

      case RpcStub.prototype:
        return "stub";

      case RpcPromise.prototype:
        return "rpc-promise";

      // TODO: Promise<T> or thenable

      default:
        if (workersModule) {
          // TODO: We also need to match `RpcPromise` and `RpcProperty`, but they currently aren't
          //   exported by cloudflare:workers.
          if (prototype == workersModule.RpcStub.prototype ||
              value instanceof workersModule.ServiceStub) {
            return "rpc-target";
          } else if (prototype == workersModule.RpcPromise.prototype ||
                    prototype == workersModule.RpcProperty.prototype) {
            // Like rpc-target, but should be wrapped in RpcPromise, so that it can be pull()ed,
            // which will await the thenable.
            return "rpc-thenable";
          }
        }

        if (value instanceof RpcTarget) {
          return "rpc-target";
        }

        if (value instanceof Error) {
          return "error";
        }

        return "unsupported";
    }
  }
}

export const JSON_CODEC = new JsonCodec();
