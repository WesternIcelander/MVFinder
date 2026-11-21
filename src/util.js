export class HttpError extends Error {
  /** @param {number} status HTTP status to return. @param {string} source "spotify" | "youtube" | "request" | "server" */
  constructor(status, source, message, upstreamStatus = null) {
    super(message);
    this.status = status;
    this.source = source;
    this.upstreamStatus = upstreamStatus;
  }
}

export const log = (...args) => console.log(new Date().toISOString(), ...args);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Semaphore {
  constructor(n) {
    this.free = n;
    this.queue = [];
  }
  async acquire() {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.free++;
  }
}
