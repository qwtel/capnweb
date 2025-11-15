// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { WireMessage } from "./codec.js";
import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";
import { POSTMESSAGE_CODEC } from "./postmessage-codec.js";

const MESSAGE = '@cloudflare/capnweb/message';
const CLOSE = '@cloudflare/capnweb/close';

interface MessageEventTarget<T> {
  addEventListener<K extends keyof MessageEventTargetEventMap>(type: K, listener: (this: T, ev: MessageEventTargetEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof MessageEventTargetEventMap>(type: K, listener: (this: T, ev: MessageEventTargetEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

export interface Endpoint extends MessageEventTarget<Endpoint> {
  postMessage(message: any, transfer?: Transferable[]|StructuredSerializeOptions): void;
  start?: () => void;
  close?: () => void;
  [Symbol.dispose]?: () => void;
}

// Start a MessagePort session given a MessagePort or a pair of MessagePorts.
//
// `localMain` is the main RPC interface to expose to the peer. Returns a stub for the main
// interface exposed from the peer.
export function newMessagePortRpcSession(
    port: MessagePort, localMain?: any, options?: RpcSessionOptions): RpcStub {
  let transport = new MessagePortTransport(port);
  let rpc = new RpcSession(transport, localMain, { ...options, codec: options?.codec || POSTMESSAGE_CODEC });
  return rpc.getRemoteMain();
}

// Start an RPC session over any generic postMessage-style endpoint.
export function newEndpointRpcSession(
    endpoint: Endpoint, localMain?: any, options?: RpcSessionOptions): RpcStub {
  let transport = new MessagePortTransport(endpoint);
  let rpc = new RpcSession(transport, localMain, { ...options, codec: options?.codec || POSTMESSAGE_CODEC });
  return rpc.getRemoteMain();
}

class MessagePortTransport implements RpcTransport {
  constructor (port: Endpoint) {
    this.#port = port;

    // Start listening for messages if supported (e.g., MessagePort).
    port.start?.();

    port.addEventListener("message", (event: MessageEvent<any>) => {
      if (this.#error) {
        // Ignore further messages.
      } else if (event?.data?.type === CLOSE) {
        // Peer is signaling that they're closing the connection
        this.#receivedError(new Error("Peer closed MessagePort connection."));
      } else if (event?.data?.type === MESSAGE) {
        if (this.#receiveResolver) {
          this.#receiveResolver(event.data.value);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(event.data.value);
        }
      } else {
        this.#receivedError(new TypeError("Received unsupported message from MessagePort."));
      }
    });

    port.addEventListener("messageerror", (event: MessageEvent) => {
      this.#receivedError(new Error("MessagePort message error."));
    });
  }

  #port: Endpoint;
  #receiveResolver?: (message: WireMessage) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: WireMessage[] = [];
  #error?: any;

  async send(message: WireMessage): Promise<void> {
    if (this.#error) {
      throw this.#error;
    }
    this.#port.postMessage({ type: MESSAGE, value: message });
  }

  async receive(): Promise<WireMessage> {
    if (this.#receiveQueue.length > 0) {
      return this.#receiveQueue.shift()!;
    } else if (this.#error) {
      throw this.#error;
    } else {
      return new Promise<WireMessage>((resolve, reject) => {
        this.#receiveResolver = resolve;
        this.#receiveRejecter = reject;
      });
    }
  }

  abort?(reason: any): void {
    // Send close signal to peer before closing
    try {
      this.#port.postMessage({ type: CLOSE });
    } catch (err) {
      // Ignore errors when sending close signal - port might already be closed
    }

    try {
      this.#port.close?.();
    } catch {}

    if (!this.#error) {
      this.#error = reason;
      // No need to call receiveRejecter(); RPC implementation will stop listening anyway.
    }
  }

  #receivedError(reason: any) {
    if (!this.#error) {
      this.#error = reason;
      if (this.#receiveRejecter) {
        this.#receiveRejecter(reason);
        this.#receiveResolver = undefined;
        this.#receiveRejecter = undefined;
      }
    }
  }
}
