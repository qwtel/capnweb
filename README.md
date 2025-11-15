# Cap'n Web X

Extensions for Cap'n Web to make it a real alternative to Comlink for the Web Worker/IPC use case, along with other improvements and additions:

### Codecs
Added support for multiple "Codecs" (from en**co**der-**dec**oder) besides JSON parse/stringification. 
A given transport might support more efficient ways of encoding data, and pluggable codecs allow you to take advantage of that. For example, `MessagePort`s support all of the Structured Clone Algorithm, so most types that need special tagging in the JSON codec can be treated as a `"primitive"` instead. Changed the message port session to use this codec by default.

### Raw tagging
Added a mechanism to tag entire subtrees as "raw" so that Cap'n Web will not process them in any way. Unlike Comlink, Cap'n Web will fully traverse any nested objects in the arguments or return value to a) find any `RpcTargets` to stub and to b) tag any types not supported by the JSON codec (e.g. `Date`, `bigint` etc.). 
This adds significant overhead when passing large, deeply nested structures, even if you know for a fact that they contain neither RPC targets nor unsupported data for a given codec. The `raw` method lets you tag these subtrees to opt them out of Cap'n Web and pass directly to the transport/codec. 

This is a performance optimization intended for advanced users when passing large structures shows signs of performance degradation. 

### Better TypeScript support
For reasons that aren't even entirely clear to me (this part was almost entirely written by AI), the upstream type definitions explode in complexity and provide no useful Editor features like "Jump to Definition" or "Find All References" the way Comlink does. These updated definitions here seemingly do, though they might still be imprecise or incorrect in certain scenarios. As far as my usage goes, they are a big improvement.

### Support for abort signals
Added support to send `AbortSignal`s and native promises across RPC boundaries. The use case here is to let a backend respond to a cancellation from the frontend in a custom way.

The way this would work in upstream is by returning a RPC target that allows aborting, e.g.

```js
class LongDayFactory extends RpcTarget {
  goToWork() { // "Hope I don't have a long day"
    const ctrl = new AbortController();
    const { signal } = ctrl;
    return new class extends RpcTarget {
      async result() {
        return (await fetch(WORK_URL, { signal })).json();
      }
      abort() {
        ctrl.abort();
      }
    }
  }
}
```

Instead, rather than having to return a RPC target, this fork allows the signal to be passed as an argument, the way it works in native functions like `fetch`:

```js
class LongDayFactory extends RpcTarget {
  goToWork(signal) {
    return (await fetch(WORK_URL, { signal })).json();
  }
}
```

The abort signal exists purely in userland. From the perspective of Cap'n Web, it's just another RPC call, which completes normally.

The reason native promise and abort signals are bundled together here is because they are conceptually the same: A one-way latch that either resolves at some point in the future (or doesn't).

Cap'n Web already has machinery to handle promises via its import/export tabes and the abort signal support is piggy-backing on top of it, though I'm not 100% confident that I'm using it correctly. Tests are encouraging, but there's open questions regarding garbage collection. There's an impromptu `FinalizationRegistry` specifically for the signals, but that's notoriously difficult to test. 

### Support for Typed Arrays
Can send typed arrays besides `Uint8Array` across RPC boundaries.

### New Transports 
Added a Chrome Web Extension Transport and a generic transport for full duplex stream pairs.

## Not included
- Map/Set in JSON codec (maybe coming to upstream), finding/replacing `RpcTarget`s in Map/Set in any codec
- ArrayBuffer in JSON codec
- Support for `postMessage`'s `transfer` argument. Something similar to `Comlink.transfer` is needed
- Out of Band transfer. Some transports could support sending buffers out of band (e.g. WebSocket binary frames, HTTP batch session via `form-data/multipart`).
- Stream/Async Iterable support (maybe coming to upstream)
- More transports: Electron IPC, Tauri IPC, etc, Node child process `send`, etc.
- More codecs: MessagePack, CBOR, ?

***

Even with all these enhancements, I haven't been able to replace my current Comlink setup with Cap'n Web, so I've temporarily paused work on this. 

