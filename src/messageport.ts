// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { WireMessage } from "./codec.js";
import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";

const MESSAGE = '@@cloudflare/capnweb/message';
const CLOSE = '@@cloudflare/capnweb/close';

// Generic postMessage-style endpoint.
// Security concerns (e.g., targetOrigin) are intentionally not modeled here.
export interface Endpoint {
  postMessage(message: any, ...args: any[]): any;
  addEventListener(type: "message" | "messageerror", listener: (event: any) => void, ...args: any[]): any;
  start?: () => void;
  close?: () => void;
}

// Start a MessagePort session given a MessagePort or a pair of MessagePorts.
//
// `localMain` is the main RPC interface to expose to the peer. Returns a stub for the main
// interface exposed from the peer.
export function newMessagePortRpcSession(
    port: MessagePort, localMain?: any, options?: RpcSessionOptions): RpcStub {
  let transport = new MessagePortTransport(port);
  let rpc = new RpcSession(transport, localMain, options);
  return rpc.getRemoteMain();
}

// Start an RPC session over any generic postMessage-style endpoint.
export function newEndpointRpcSession(
    endpoint: Endpoint, localMain?: any, options?: RpcSessionOptions): RpcStub {
  let transport = new MessagePortTransport(endpoint);
  let rpc = new RpcSession(transport, localMain, options);
  return rpc.getRemoteMain();
}

class MessagePortTransport implements RpcTransport {
  constructor (endpoint: Endpoint) {
    this.#endpoint = endpoint;

    // Start listening for messages if supported (e.g., MessagePort).
    endpoint.start?.();

    endpoint.addEventListener("message", (event: any) => {
      if (this.#error) {
        // Ignore further messages.
      } else if (event?.data?.type === CLOSE) {
        // Peer is signaling that they're closing the connection
        this.#receivedError(new Error("Peer closed MessagePort connection."));
      } else if (event?.data?.type === MESSAGE) {
        const msg: WireMessage = event.data.value;
        if (this.#receiveResolver) {
          this.#receiveResolver(msg);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(msg);
        }
      } else {
        this.#receivedError(new TypeError("Received unsupported message from MessagePort."));
      }
    });

    endpoint.addEventListener("messageerror", (_event: any) => {
      this.#receivedError(new Error("MessagePort message error."));
    });
  }

  #endpoint: Endpoint;
  #receiveResolver?: (message: WireMessage) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: (WireMessage)[] = [];
  #error?: any;

  async send(message: WireMessage): Promise<void> {
    if (this.#error) {
      throw this.#error;
    }
    this.#endpoint.postMessage({ type: MESSAGE, value: message });
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
      this.#endpoint.postMessage({ type: CLOSE });
    } catch (err) {
      // Ignore errors when sending close signal - port might already be closed
    }

    // Close if supported (e.g., MessagePort).
    try {
      this.#endpoint.close?.();
    } catch (_err) {}

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
