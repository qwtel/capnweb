---
"capnweb": minor
---

The package now exports the type `RpcCompatible<T>` (previously called `Serializable<T>`, but not exported), which is needed when writing generic functions on `RpcStub` / `RpcPromise`.
