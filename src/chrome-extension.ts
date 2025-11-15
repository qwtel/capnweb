/// <reference types="chrome" />

import type { WireMessage } from "./codec.js";
import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";
import { OBJECT_CODEC } from "./object-codec.js";

const MESSAGE = '@cloudflare/capnweb/message';
const CLOSE = '@cloudflare/capnweb/close';
const RPC_MESSAGE_PREFIX = '@cloudflare/capnweb/rpc';

const kHandleIncomingMessage = Symbol('handleIncomingMessage');
const kHandleClose = Symbol('handleClose');

// Global state for background service connections
const backgroundConnections = new Map<string, { 
  transport: ChromeExtensionTransport, 
  // session: RpcSession, 
  // remoteMain: RpcStub
}>();

// Start a Chrome Extension RPC session using message-based communication.
//
// `localMain` is the main RPC interface to expose to the peer. Returns a stub for the main
// interface exposed from the peer.
export function newChromeExtensionRpcSession(
    localMain?: any, options?: RpcSessionOptions): RpcStub {
  const connectionId = `${RPC_MESSAGE_PREFIX}-${crypto.randomUUID()}`;
  let transport = new ChromeExtensionTransport(connectionId, undefined);
  let rpc = new RpcSession(transport, localMain, { ...options, codec: options?.codec || OBJECT_CODEC });
  return rpc.getRemoteMain();
}

// Set up Chrome extension RPC session for background scripts.
//
// Sets up a listener for chrome.runtime.onMessage and creates a new RPC session for each
// incoming connection with an unknown connection ID. Returns a Map of connection identifiers to RPC stubs.
export function newChromeExtensionRpcBackgroundService(
    localMain?: (sender?: chrome.runtime.MessageSender) => any, options?: RpcSessionOptions): Map<string, RpcStub> {
  const sessions = new Map<string, RpcStub>();

  chrome.runtime.onMessage.addListener((message: unknown, sender: chrome.runtime.MessageSender) => {
    // Only handle RPC messages - check for connectionId that starts with our prefix
    if (
      typeof message !== 'object' || 
      !message || 
      !('connectionId' in message) || 
      !('type' in message) || 
      !('value' in message) || 
      typeof message.connectionId !== 'string' ||
      typeof message.type !== 'string'
    ) {
      return false; // Not our message, don't claim it
    }

    const connectionId = message.connectionId;
    if (!connectionId.startsWith(RPC_MESSAGE_PREFIX)) {
      return false; // Not an RPC connection ID
    }

    // If this is a new connection, create a session for it
    if (!backgroundConnections.has(connectionId)) {
      const main = localMain?.(sender);
      const transport = new ChromeExtensionTransport(connectionId, sender);
      const session = new RpcSession(transport, main, { ...options, codec: options?.codec || OBJECT_CODEC });
      const remoteMain = session.getRemoteMain();

      backgroundConnections.set(connectionId, { transport, /* session, remoteMain */ });
      sessions.set(connectionId, remoteMain);
    }

    const connection = backgroundConnections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    // Handle the message
    if (message.type === CLOSE) {
      connection.transport[kHandleClose]();
      backgroundConnections.delete(connectionId);
      sessions.delete(connectionId);
      return false;
    } else if (message.type === MESSAGE) {
      connection.transport[kHandleIncomingMessage](message.value as any);
      return false; // Async response handled by transport
    }

    return false;
  });

  return sessions;
}

class ChromeExtensionTransport implements RpcTransport {
  constructor (connectionId: string, sender?: chrome.runtime.MessageSender) {
    this.#connectionId = connectionId;
    this.#sender = sender;

    // Set up message listener for client side (when sender is undefined)
    if (!sender) {
      chrome.runtime.onMessage.addListener((message: any) => {
        // Only handle messages for this connection
        if (message?.connectionId !== this.#connectionId) {
          return false; // Not for this connection
        }

        if (this.#error) {
          // Ignore further messages.
          return false;
        }

        if (message.type === CLOSE) {
          this.#receivedError(new Error("Peer closed Chrome Extension connection."));
          return false;
        } else if (message.type === MESSAGE) {
          this[kHandleIncomingMessage](message.value);
          return false;
        }

        return false;
      });
    }
  }

  #connectionId: string;
  #sender?: chrome.runtime.MessageSender;
  #receiveResolver?: (message: WireMessage) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: WireMessage[] = [];
  #error?: any;

  async send(message: WireMessage): Promise<void> {
    if (this.#error) {
      throw this.#error;
    }

    const envelope = {
      type: MESSAGE,
      connectionId: this.#connectionId,
      value: message
    };

    try {
      if (this.#sender) {
        // Background sending to client: use tabs.sendMessage
        if (this.#sender.tab?.id !== undefined) {
          await chrome.tabs.sendMessage(this.#sender.tab.id, envelope);
        } else if (this.#sender.frameId !== undefined && this.#sender.tab?.id !== undefined) {
          await chrome.tabs.sendMessage(this.#sender.tab.id, envelope, { frameId: this.#sender.frameId });
        } else {
          throw new Error("Cannot send message: missing tab or frame ID");
        }
      } else {
        // Client sending to background: use runtime.sendMessage
        await chrome.runtime.sendMessage(envelope);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to send message to Chrome Extension.");
      this.#receivedError(error);
      throw error;
    }
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
    // Send close signal to peer
    const envelope = {
      type: CLOSE,
      connectionId: this.#connectionId
    };

    try {
      if (this.#sender) {
        // Background sending to client
        if (this.#sender.tab?.id !== undefined) {
          chrome.tabs.sendMessage(this.#sender.tab.id, envelope).catch(() => {});
        }
      } else {
        // Client sending to background
        chrome.runtime.sendMessage(envelope).catch(() => {});
      }
    } catch (err) {
      // Ignore errors when sending close signal
    }

    if (!this.#error) {
      this.#error = reason;
      // No need to call receiveRejecter(); RPC implementation will stop listening anyway.
    }
  }

  [kHandleIncomingMessage](message: WireMessage) {
    if (this.#receiveResolver) {
      this.#receiveResolver(message);
      this.#receiveResolver = undefined;
      this.#receiveRejecter = undefined;
    } else {
      this.#receiveQueue.push(message);
    }
  }

  [kHandleClose]() {
    this.#receivedError(new Error("Peer closed Chrome Extension connection."));
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
