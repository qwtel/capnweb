// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Common RPC interfaces / implementations used in several tests.

import { RpcStub, RpcTarget } from '../src/index.js';

export class Counter extends RpcTarget {
  constructor(private i: number = 0) {
    super();
  }

  increment(amount: number = 1): number {
    this.i += amount;
    return this.i;
  }

  get value() {
    return this.i;
  }
}

// Distinct function so we can search for it in the stack trace.
function throwErrorImpl(): never {
  throw new RangeError("test error");
}

export class SubSubTestTarget extends RpcTarget {
  getValue() { return 42; }
}

export class SubTestTarget extends RpcTarget {
  squareRoot(i: number) { 
    return Math.sqrt(i);
  }
  getSubSubTarget() {
    return new SubSubTestTarget();
  }
}

export class TestTarget extends RpcTarget {
  square(i: number) {
    return i * i;
  }

  callSquare(self: RpcStub<TestTarget>, i: number) {
    return { result: self.square(i) };
  }

  throwError() {
    throwErrorImpl();
  }

  makeCounter(i: number) {
    return new Counter(i);
  }

  incrementCounter(c: RpcStub<Counter>, i: number = 1) {
    return c.increment(i);
  }

  generateFibonacci(length: number) {
    let result = [0, 1];
    if (length <= result.length) return result.slice(0, length);

    while (result.length < length) {
      let next = result[result.length - 1] + result[result.length - 2];
      result.push(next);
    }

    return result;
  }

  returnNull() { return null; }
  returnUndefined() { return undefined; }
  returnNumber(i: number) { return i; }

  fill255<T extends TypedArray>(x: T): T {
    new Uint8Array(x.buffer, x.byteOffset, x.byteLength).fill(255);
    return x;
  }

  async getSubTarget(): Promise<SubTestTarget> {
    await new Promise(queueMicrotask);
    return new SubTestTarget();
  }

  async getSubSubTarget(x: RpcStub<SubTestTarget>) {
    return x.getSubSubTarget();
  }

  async acceptCalculation(calculation: Promise<number>) {
    await new Promise(queueMicrotask);
    await calculation;
  }
}

export function setSubStub(value: RpcStub<SubTestTarget>): void {
  value;
}
export function setSubSubStub(value: RpcStub<SubSubTestTarget>): void {
  value;
}


export class UnhandledRejectionTracker {
  private rejections: Array<{ error: any; timestamp: number }> = [];
  private nodeHandler: ((reason: any, promise: Promise<any>) => void) | null = null;
  private browserHandler: ((event: any) => void) | null = null;

  start() {
    if (typeof process !== 'undefined' && process.on) {
      this.nodeHandler = (reason: any, _promise: Promise<any>) => {
        this.rejections.push({ error: reason, timestamp: Date.now() });
        console.warn('📋 Tracked unhandled rejection:', reason);
      };
      process.on('unhandledRejection', this.nodeHandler);
    } else if (typeof window !== 'undefined') {
      this.browserHandler = (event: any) => {
        this.rejections.push({ error: event.reason, timestamp: Date.now() });
        console.warn('📋 Tracked unhandled rejection:', event.reason);
      };
      window.addEventListener('unhandledrejection', this.browserHandler);
    }
  }

  stop() {
    if (this.nodeHandler && typeof process !== 'undefined' && process.off) {
      process.off('unhandledRejection', this.nodeHandler);
      this.nodeHandler = null;
    }
    if (this.browserHandler && typeof window !== 'undefined') {
      window.removeEventListener('unhandledrejection', this.browserHandler);
      this.browserHandler = null;
    }
  }

  getRejections() {
    return [...this.rejections];
  }

  clear() {
    this.rejections.length = 0;
  }

  hasRejections() {
    return this.rejections.length > 0;
  }

  expectRejection(matcher: (error: any) => boolean): boolean {
    return this.rejections.some(({ error }) => matcher(error));
  }

  [Symbol.dispose]() {
    this.stop();
  }
}
