// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// This file borrows heavily from `types/defines/rpc.d.ts` in workerd.

// Branded types for identifying `WorkerEntrypoint`/`DurableObject`/`Target`s.
// TypeScript uses *structural* typing meaning anything with the same shape as type `T` is a `T`.
// For the classes exported by `cloudflare:workers` we want *nominal* typing (i.e. we only want to
// accept `WorkerEntrypoint` from `cloudflare:workers`, not any other class with the same shape)
export const __RPC_STUB_BRAND: '__RPC_STUB_BRAND';
export const __RPC_TARGET_BRAND: '__RPC_TARGET_BRAND';
export interface RpcTargetBranded {
  [__RPC_TARGET_BRAND]: never;
}

// Types that can be used through `Stub`s
export type Stubable = RpcTargetBranded | ((...args: any[]) => any);

// Types that can be passed over RPC
// The reason for using a generic type here is to build a serializable subset of structured
//   cloneable composite types. This allows types defined with the "interface" keyword to pass the
//   serializable check as well. Otherwise, only types defined with the "type" keyword would pass.
export type Serializable<T> =
  // Structured cloneables
  | BaseType
  // Structured cloneable composites
  | Map<
      T extends Map<infer U, unknown> ? Serializable<U> : never,
      T extends Map<unknown, infer U> ? Serializable<U> : never
    >
  | Set<T extends Set<infer U> ? Serializable<U> : never>
  | Array<T extends Array<infer U> ? Serializable<U> : never>
  | ReadonlyArray<T extends ReadonlyArray<infer U> ? Serializable<U> : never>
  | {
      [K in keyof T]: K extends number | string ? Serializable<T[K]> : never;
    }
  | Promise<T extends Promise<infer U> ? Serializable<U> : never>
  // Special types
  | Stub<Stubable>
  // Serialized as stubs, see `Stubify`
  | Stubable;

// Base type for all RPC stubs, including common memory management methods.
// `T` is used as a marker type for unwrapping `Stub`s later.
interface StubBase<T extends Serializable<T>> extends Disposable {
  [__RPC_STUB_BRAND]: T;
  dup(): this;
  onRpcBroken(callback: (error: any) => void): void;
}

/**
 * Takes the raw type of a remote object, function or class in the other thread and returns the type as it is visible to
 * the local thread from the stub.
 */
export type Stub<T extends Serializable<T>> =
  // Handle properties
  (T extends object ? StubObject<T> : T) &
    // Handle call signature (if present)
    (T extends (...args: infer TArguments) => infer TReturn
      ? (
          ...args: { [I in keyof TArguments]: UnstubOrClone<TArguments[I]> }
        ) => Promisify<StubOrClone<Awaited<TReturn>>>
      : unknown) &
    // Include additional special stub methods available on the stub.
    StubBase<T>;

type TypedArray =
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigUint64Array
  | BigInt64Array
  | Float16Array
  | Float32Array
  | Float64Array;

// This represents all the types that can be sent as-is over an RPC boundary
type BaseType =
  | void
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | TypedArray
  | ArrayBuffer
  | DataView
  | Date
  | Error
  | RegExp
  | ReadableStream<Uint8Array>
  | WritableStream<Uint8Array>
  | Request
  | Response
  | Headers;
// Recursively rewrite all `Stubable` types with `Stub`s, and resolve promises.
// prettier-ignore
export type Stubify<T> =
  T extends Stubable ? Stub<T>
  : T extends Promise<infer U> ? Stubify<U>
  : T extends StubBase<any> ? T
  : T extends Map<infer K, infer V> ? Map<Stubify<K>, Stubify<V>>
  : T extends Set<infer V> ? Set<Stubify<V>>
  : T extends Array<infer V> ? Array<Stubify<V>>
  : T extends ReadonlyArray<infer V> ? ReadonlyArray<Stubify<V>>
  : T extends BaseType ? T
  // When using "unknown" instead of "any", interfaces are not stubified.
  : T extends { [key: string | number]: any } ? { [K in keyof T]: Stubify<T[K]> }
  : T;

// Recursively rewrite all `Stub<T>`s with the corresponding `T`s.
// Note we use `StubBase` instead of `Stub` here to avoid circular dependencies.
// prettier-ignore
type UnstubifyInner<T> =
  T extends StubBase<infer V> ? (T | V)  // can provide either stub or local RpcTarget
  : T extends Map<infer K, infer V> ? Map<Unstubify<K>, Unstubify<V>>
  : T extends Set<infer V> ? Set<Unstubify<V>>
  : T extends Array<infer V> ? Array<Unstubify<V>>
  : T extends ReadonlyArray<infer V> ? ReadonlyArray<Unstubify<V>>
  : T extends BaseType ? T
  : T extends { [key: string | number]: unknown } ? { [K in keyof T]: Unstubify<T[K]> }
  : T;

// You can put promises anywhere in the params and they'll be resolved before delivery.
// (This also covers RpcPromise, because it's defined as being a Promise.)
type Unstubify<T> = UnstubifyInner<T> | Promise<UnstubifyInner<T>>

type UnstubifyAll<A extends any[]> = { [I in keyof A]: Unstubify<A[I]> };

// Utility type for adding `Disposable`s to `object` types only.
// Note `unknown & T` is equivalent to `T`.
type MaybeDisposable<T> = T extends object ? Disposable : unknown;

/**
 * Takes a type and wraps it in a Promise, if it not already is one.
 * This is to avoid `Promise<Promise<T>>`.
 */
type Promisify<T> = T extends PromiseLike<unknown> ? T : Promise<T>;

/**
 * Helper type for the `map()` method that allows pipelining operations.
 * If T is an array, maps over elements; otherwise maps over the value itself.
 */
type MapMethod<T> =
  T extends Array<infer U>
    ? {
        map<V>(callback: (elem: U) => V): StubResult<Array<V>>;
      }
    : {
        map<V>(callback: (value: NonNullable<T>) => V): StubResult<Array<V>>;
      };

// Type for method return or property on an RPC interface.
// - Stubable types are replaced by stubs.
// - Serializable types are passed by value, with stubable types replaced by stubs
//   and a top-level `Disposer`.
// Everything else can't be passed over RPC.
// Technically, we use custom thenables here, but they quack like `Promise`s.
// Intersecting with `Stub<R>` allows pipelining when R is Stubable.
// The `map()` method allows pipelining operations on the result value.
// prettier-ignore
type StubResult<R> =
  (R extends Stubable
    ? Promisify<Stub<Awaited<R>>> & Stub<Awaited<R>> & StubBase<Awaited<R>>
    : R extends Serializable<R> ? Promisify<Stubify<Awaited<R>> & MaybeDisposable<Awaited<R>>> & StubBase<Awaited<R>> 
    : never) & MapMethod<Awaited<R>>

/**
 * Takes the raw type of a remote property and returns the type that is visible to the local thread on the stub.
 *
 * Note: This needs to be its own type alias, otherwise it will not distribute over unions.
 * See https://www.typescriptlang.org/docs/handbook/advanced-types.html#distributive-conditional-types
 */
type StubProperty<T> =
  // If the value is a function, it becomes a callable stub that returns StubResult.
  // If it's a Stubable, it becomes a stub.
  // Otherwise, the property is converted to a StubResult that resolves the cloned/stubified value with pipelining support.
  T extends (...args: infer P) => infer R
    ? (...args: { [I in keyof P]: UnstubOrClone<P[I]> }) => StubResult<Awaited<R>>
    : T extends Stubable
    ? Stub<T>
    : StubResult<T>;

/**
 * Proxies `T` if it is a `Stubable`, clones/stubifies it otherwise.
 */
type StubOrClone<T> = T extends Stubable ? Stub<T> : Stubify<T>;

/**
 * Inverse of `StubOrClone<T>`.
 * Allows passing Stubs, StubResults (promises), and StubObjects as arguments.
 * Promises are automatically resolved before delivery.
 */
type UnstubOrClone<T> = 
  // Handle Stub<T> - unwrap to T or allow Stub itself
  T extends Stub<infer U>
    ? U & Stubable | Stub<U>
    // Handle StubObject<Stubable>
    : T extends StubObject<Stubable>
    ? Unstubify<T>
    // Handle StubResult<T> (promises) - unwrap to the underlying type
    : T extends StubResult<infer U>
    ? T | UnstubOrClone<U>
    // For any type T, allow StubResult<T> (promise pipelining) or the type itself
    : StubResult<T> | T;

/**
 * Takes the raw type of a remote object in the other thread and returns the type as it is visible to the local thread
 * when proxied with a stub.
 *
 * This does not handle call signatures, which is handled by the more general `Stub<T>` type.
 *
 * @template T The raw type of a remote object as seen in the other thread.
 */
type StubObject<T> =
  // Handle arrays specially with numeric indices and map() method
  T extends Array<infer U>
    ? {
        [key: number]: StubProperty<U>;
      } & MapMethod<T>
    : // Handle regular objects with all properties and map() method
      {
        [P in keyof T as Exclude<P, symbol>]: StubProperty<T[P]>;
      } & MapMethod<T>;
