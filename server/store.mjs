import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { createInitialState, normalizeProfile } from "./domain.mjs";

function clone(value) {
  return structuredClone(value);
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export class JsonStateStore {
  #filePath;
  #profile;
  #state;
  #tail = Promise.resolve();
  #writeSequence = 0;

  constructor({ filePath, profile }) {
    if (!filePath) throw new TypeError("filePath is required");
    this.#filePath = filePath;
    this.#profile = normalizeProfile(profile);
  }

  get filePath() {
    return this.#filePath;
  }

  get profile() {
    return this.#profile;
  }

  async init() {
    await mkdir(dirname(this.#filePath), { recursive: true });
    let state;
    try {
      const raw = await readFile(this.#filePath, "utf8");
      state = JSON.parse(raw);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error instanceof SyntaxError) {
          throw new Error(`Invalid JSON state file at ${this.#filePath}`, {
            cause: error,
          });
        }
        throw error;
      }
    }

    if (!state || state.schemaVersion !== 1 || state.profile !== this.#profile) {
      state = createInitialState(this.#profile);
      await this.#writeAtomic(state);
    }
    this.#state = state;
    return this.read();
  }

  async read() {
    return this.#exclusive(() => {
      this.#assertReady();
      return clone(this.#state);
    });
  }

  async update(mutator) {
    if (typeof mutator !== "function") throw new TypeError("mutator is required");
    return this.#exclusive(async () => {
      this.#assertReady();
      const draft = clone(this.#state);
      const result = await mutator(draft);
      draft.revision = this.#state.revision + 1;
      await this.#writeAtomic(draft);
      this.#state = draft;
      return { state: clone(draft), result: clone(result) };
    });
  }

  async reset() {
    return this.#exclusive(async () => {
      const state = createInitialState(this.#profile);
      await this.#writeAtomic(state);
      this.#state = state;
      return clone(state);
    });
  }

  #assertReady() {
    if (!this.#state) throw new Error("JsonStateStore.init() must be called first");
  }

  #exclusive(operation) {
    const task = this.#tail.then(operation, operation);
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async #writeAtomic(state) {
    const directory = dirname(this.#filePath);
    const tempPath = `${this.#filePath}.${process.pid}.${++this.#writeSequence}.tmp`;
    const body = `${JSON.stringify(state, null, 2)}\n`;
    let handle;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, this.#filePath);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
