// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

/// <reference types="chrome" />

import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";
import { OBJECT_CODEC } from "./object-codec.js";
import type { WireMessage } from "./codec.js";

const MESSAGE = '@cloudflare/capnweb/message';
const CLOSE = '@cloudflare/capnweb/close';
const PORT_PREFIX = '@cloudflare/capnweb/port-';

// Start a Chrome extension RPC session.
//
// This function internally calls `chrome.runtime.connect()` to establish a connection and extract
// connection metadata (like tab ID). The port is used only for the initial handshake and then
// discarded. All RPC communication uses fire-and-forget messaging.
//
// `localMain` is the main RPC interface to expose to the peer. Returns a stub for the main
// interface exposed from the peer.
export function newChromeExtensionRpcSession(
    localMain?: any, options?: RpcSessionOptions): RpcStub {
  // Generate unique port name for this connection
  const portName = `${PORT_PREFIX}${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  
  // Create a port for the initial handshake
  const port = chrome.runtime.connect({ name: portName });
  
  // Extract tab ID from port sender if available
  const tabId = port.sender?.tab?.id;
  
  const handshakeComplete = new Promise<any>((resolve) => {
    const listener = (msg: any) => {
      port.onMessage.removeListener(listener);
      port.disconnect();
      resolve(msg);
    };
    port.onMessage.addListener(listener);
  });
  
  // Create transport with extracted tab ID and handshake promise
  let transport = new ChromeExtensionTransport(tabId, handshakeComplete);
  let rpc = new RpcSession(transport, localMain, { ...options, codec: options?.codec || OBJECT_CODEC });

  // Return immediately, handshake is handled by transport
  return rpc.getRemoteMain();
}

// Set up Chrome extension RPC session for background scripts.
//
// This function should be called inside `chrome.runtime.onConnect.addListener((port) => ...)`.
// It extracts connection metadata from the port (like tab ID) and sets up an RPC session.
// The port is used only for the initial handshake and then discarded. All RPC communication
// uses fire-and-forget messaging.
//
// `port` is the port received from `chrome.runtime.onConnect.addListener`.
// `localMain` is the main RPC interface to expose to the peer.
function newChromeExtensionRpcResponse(
    port: chrome.runtime.Port, localMain?: any, options?: RpcSessionOptions): RpcStub {
  // Only handle ports with capnweb prefix
  if (!port.name || !port.name.startsWith(PORT_PREFIX)) {
    throw Error('Invalid port name');
  }
  
  // Extract tab ID from port sender if available
  const tabId = port.sender?.tab?.id;
  
  // Create transport with extracted tab ID
  let transport = new ChromeExtensionTransport(tabId);
  let rpc = new RpcSession(transport, localMain, { ...options, codec: options?.codec || OBJECT_CODEC });

  // Handle handshake message from content script
  port.postMessage({});
  
  return rpc.getRemoteMain();
}

async function defaultListener() {
  const envelope = { type: CLOSE };
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id != null) {
      await chrome.tabs.sendMessage(tab.id, envelope).catch(() => {});
    }
  }));
}

export function newChromeExtensionRpcBackgroundService(
  localMain?: (sender?: chrome.runtime.MessageSender) => any,
  options?: RpcSessionOptions,
): Map<string, RpcStub> {
  const sessions = new Map();

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(PORT_PREFIX)) return;
    chrome.runtime.onMessage.removeListener(defaultListener);

    const stub = newChromeExtensionRpcResponse(
      port,
      localMain?.(port.sender),
      options,
    );
    sessions.set(port.name, stub);
  });

  chrome.runtime.onMessage.addListener(defaultListener);

  return sessions;
}

class ChromeExtensionTransport implements RpcTransport {
  constructor(tabId?: number, handshakePromise?: Promise<any>) {
    this.#tabId = tabId;
    this.#handshakePromise = handshakePromise;

    // Set up message listener for receiving messages
    chrome.runtime.onMessage.addListener(this.#handleMessage);
  }

  #tabId?: number;
  #handshakePromise?: Promise<any>;
  #receiveResolver?: (message: WireMessage) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: WireMessage[] = [];
  #error?: any;
  #listenerAttached = true;

  #handleMessage = (
    message: any,
    sender: chrome.runtime.MessageSender,
  ): boolean => {
    if (!this.#listenerAttached) {
      // Listener was removed, ignore messages
      return false;
    }

    // Auto-detect tab ID from sender if not already set
    if (this.#tabId === undefined && sender.tab?.id !== undefined) {
      this.#tabId = sender.tab.id;
    }

    // If we have a specific tab ID, only accept messages from that tab
    if (this.#tabId !== undefined && sender.tab?.id !== this.#tabId) {
      // Message from wrong tab, ignore it
      return false;
    }

    if (this.#error) {
      // Ignore further messages.
      return false;
    } else if (message?.type === CLOSE) {
      // Peer is signaling that they're closing the connection
      this.#receivedError(new Error("Peer closed Chrome extension connection."));
      return false;
    } else if (message?.type === MESSAGE) {
      const msg: WireMessage = message.value;
      if (this.#receiveResolver) {
        this.#receiveResolver(msg);
        this.#receiveResolver = undefined;
        this.#receiveRejecter = undefined;
      } else {
        this.#receiveQueue.push(msg);
      }
      return false;
    } else {
      // Not a message for us, let other handlers process it
      return false;
    }
  };

  async send(message: WireMessage): Promise<void> {
    if (this.#error) {
      throw this.#error;
    }

    await this.#handshakePromise;

    const envelope = { type: MESSAGE, value: message };

    try {
      if (this.#tabId !== undefined) {
        await chrome.tabs.sendMessage(this.#tabId, envelope);
      } else {
        await chrome.runtime.sendMessage(envelope);
      }

      // Check for errors (chrome.runtime.lastError is set asynchronously, but the Promise API
      // should handle it. For tabs.sendMessage, we check it explicitly.)
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message || chrome.runtime.lastError;
        this.#receivedError(new Error(`Failed to send message: ${error}`));
        throw this.#error;
      }
    } catch (err: any) {
      // Handle errors from tabs.sendMessage (e.g., tab closed, content script not loaded)
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message || chrome.runtime.lastError;
        this.#receivedError(new Error(`Failed to send message: ${error}`));
        throw this.#error;
      }
      // Re-throw other errors
      throw err;
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
    // Remove message listener
    chrome.runtime.onMessage.removeListener(this.#handleMessage);
    this.#listenerAttached = false;

    // Send close signal to peer
    const envelope = { type: CLOSE };
    try {
      if (this.#tabId !== undefined) {
        chrome.tabs.sendMessage(this.#tabId, envelope).catch(() => {
          // Ignore errors when sending close signal - tab/content script might already be gone
        });
      } else {
        chrome.runtime.sendMessage(envelope).catch(() => {
          // Ignore errors when sending close signal - target might already be closed
        });
      }
    } catch (_err) {
      // Ignore errors when sending close signal
    }

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
