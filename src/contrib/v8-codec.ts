// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import * as v8 from "node:v8";

import { Codec, WireMessage } from "../codec.js";
import { POSTMESSAGE_CODEC } from "../postmessage-codec.js";
import { type TypeForRpc } from "../core.js";

export class V8Codec implements Codec {
  readonly name: "v8" = "v8";

  encode(message: any): WireMessage {
    const ab = v8.serialize(message);
    return ab instanceof Uint8Array ? ab : new Uint8Array(ab);
  }

  decode(wire: WireMessage): any {
    if (!(wire instanceof Uint8Array || wire instanceof ArrayBuffer)) {
      throw new TypeError("V8Codec.decode expected Uint8Array or ArrayBuffer wire payload");
    }
    // Ensure we pass an ArrayBufferView when necessary
    const view = wire instanceof Uint8Array ? wire : new Uint8Array(wire);
    // @ts-ignore: v8 typings differ across Node versions
    return v8.deserialize(view);
  }

  typeForRpc(value: unknown): TypeForRpc {
    return POSTMESSAGE_CODEC.typeForRpc(value);
  }
}

export const V8_CODEC = new V8Codec();
