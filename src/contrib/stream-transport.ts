import type { WireMessage } from "../codec.js";
import type { Empty, RpcStub, RpcCompatible } from "../index.js";

import { RpcTransport, RpcSession, RpcSessionOptions } from "../rpc.js";
import { V8_CODEC } from "./v8-codec.js";

export interface FullDuplexStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/**
 * Initiate an RPC session over a readable-writeable pair.
 * 
 * This is the most generic transport and can be used to communicate between any two 
 * endpoints that support full duplex binary streams.
 * The transport uses a minimal framing protocol to delimit messages and 
 * encodes messages using the V8 codec by default. 
 */
export let newStreamRpcSession:<T extends RpcCompatible<T> = Empty>
    (stream: FullDuplexStream, localMain?: any, options?: RpcSessionOptions) => RpcStub<T> =
    <any>newStreamRpcSessionImpl;

function newStreamRpcSessionImpl(
    stream: FullDuplexStream, localMain?: any, options?: RpcSessionOptions) {
  let transport = new StreamTransport(stream);
  let rpc = new RpcSession(transport, localMain, { ...options, codec: options?.codec || V8_CODEC });
  return rpc.getRemoteMain();
}

function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function wireMessageToUint8Array(x: WireMessage): Uint8Array {
  if (x instanceof Uint8Array) {
    return x;
  } else if (x instanceof ArrayBuffer) {
    return new Uint8Array(x);
  // } else if (ArrayBuffer.isView(bufferSource)) {
  //   return new Uint8Array(bufferSource.buffer, bufferSource.byteOffset, bufferSource.byteLength);
  } else {
    throw new TypeError("StreamTransport.send expected Uint8Array, ArrayBuffer, or ArrayBufferView");
  }
}

class StreamTransport implements RpcTransport {
  constructor(stream: FullDuplexStream) {
    this.#readable = stream.readable;
    this.#writable = stream.writable;
    this.#reader = this.#readable.getReader();
    this.#writer = this.#writable.getWriter();
  }

  #readable: ReadableStream<Uint8Array>;
  #writable: WritableStream<Uint8Array>;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #error?: any;
  #readBuffer: Uint8Array = new Uint8Array(0);
  #expectedLength?: number;

  async #readWireMessage(): Promise<Uint8Array> {
    while (true) {
      if (this.#expectedLength === undefined) {
        while (this.#readBuffer.length < 4) {
          const { done, value } = await this.#reader.read();
          if (done) {
            throw new Error("Stream readable closed.");
          }
          if (value) {
            this.#readBuffer = concatBuffers(this.#readBuffer, value);
          }
        }

        const view = new DataView(this.#readBuffer.buffer, this.#readBuffer.byteOffset, this.#readBuffer.byteLength);
        this.#expectedLength = view.getUint32(0, false);
        this.#readBuffer = this.#readBuffer.subarray(4);
      }

      while (this.#readBuffer.length < this.#expectedLength) {
        const { done, value } = await this.#reader.read();
        if (done) {
          throw new Error("Stream readable closed before message complete.");
        }
        if (value) {
          this.#readBuffer = concatBuffers(this.#readBuffer, value);
        }
      }

      const message = this.#readBuffer.subarray(0, this.#expectedLength);
      this.#readBuffer = this.#readBuffer.subarray(this.#expectedLength);
      this.#expectedLength = undefined;
      return message;
    }
  }

  async send(message: WireMessage): Promise<void> {
    if (this.#error) {
      throw this.#error;
    }

    const data = wireMessageToUint8Array(message);

    const lengthPrefix = new Uint8Array(4);
    const view = new DataView(lengthPrefix.buffer);
    view.setUint32(0, data.length, false);

    try {
      await this.#writer.ready;
      await this.#writer.write(lengthPrefix);
      await this.#writer.write(data);
    } catch (err: any) {
      const error = err instanceof Error ? err : new Error(`Stream write error: ${err}`);
      this.#error = error;
      throw error;
    }
  }

  async receive(): Promise<WireMessage> {
    if (this.#error) {
      throw this.#error;
    }

    try {
      return await this.#readWireMessage();
    } catch (err: any) {
      const error = err instanceof Error ? err : new Error(`Stream read error: ${err}`);
      this.#error = error;
      throw error;
    }
  }

  abort?(reason: any): void {
    if (!this.#error) {
      this.#error = reason;
    }

    this.#reader.cancel(reason).catch(() => {});
    this.#writer.abort(reason).catch(() => {});
  }
}

