// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { Codec, JSON_CODEC, WireMessage } from "./codec.js";
import { TypeForRpc } from "./core.js";

/** 
 * Same as JSON codec, but skips the stringification step. 
 * Useful for transports that perform JSON-stringification internally. 
 */
export class ObjectCodec implements Codec {
  readonly name = "object";

  encode(message: any): WireMessage {
    return message;
  }

  decode(wire: WireMessage): any {
    return wire;
  }

  typeForRpc(value: unknown): TypeForRpc {
    return JSON_CODEC.typeForRpc(value);
  }
}

export const OBJECT_CODEC = new ObjectCodec();
