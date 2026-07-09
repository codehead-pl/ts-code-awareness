// Learned local embedder. An `OnnxEmbedder`
// that implements the same synchronous `Embedder` interface as `HashingEmbedder`,
// backed by transformers.js running ONNX inference *over WASM* — no native
// compile, fully on-machine (the model is downloaded once from HuggingFace and
// cached to disk; nothing leaves the box afterwards).
//
// Two problems are solved here so the rest of the engine stays unchanged:
//
//  1. **Sync interface over async inference.** ONNX inference is asynchronous,
//     but `Embedder.embed()` is synchronous and used from synchronous build /
//     search paths. We run the model in a Worker and bridge to it *synchronously*
//     via `SharedArrayBuffer` + `Atomics.wait` — the caller blocks until the
//     worker writes the vector back. The model is loaded once per embedder and
//     shared across every warm project.
//
//  2. **No native ORT on this platform.** transformers.js statically imports
//     `onnxruntime-node` (a native prebuilt that isn't available for every
//     platform, e.g. darwin-x64). We (a) redirect that import to an empty stub
//     via an ESM loader hook, and (b) inject `onnxruntime-web` (WASM) as the
//     runtime through the `Symbol.for("onnxruntime")` global that transformers
//     honors. The paired pnpm patch teaches transformers' backend selector that
//     the injected runtime supports the `wasm` device.
//
// If transformers.js / onnxruntime-web can't be loaded, `loadOnnxEmbedder`
// rejects and callers fall back to `HashingEmbedder`.
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Embedder } from "./semantic.ts";
import { setDefaultEmbedder } from "./semantic.ts";

const require = createRequire(import.meta.url);

// SharedArrayBuffer control layout (Int32 slots).
const REQ = 0; // main → worker: a request is pending
const RESP = 1; // worker → main: a response is ready
const TLEN = 2; // byte length of the request text in `textBuf`
const RDIM = 3; // dims written to `resultBuf`, or -1 on error
const TEXT_CAP = 256 * 1024; // max request text (UTF-8 bytes); longer is truncated

export interface OnnxEmbedderOptions {
  /** HuggingFace model id (must have an ONNX export). */
  modelId?: string;
  /** transformers.js dtype, e.g. "q8" (int8), "fp32". */
  dtype?: string;
  /** Output dimensionality of the model (all-MiniLM-L6-v2 = 384). */
  dim?: number;
  /** Stable embedder id stored in `meta` (drives re-embed-on-model-change). */
  id?: string;
  /** Max ms to wait for the model to load on init. */
  initTimeoutMs?: number;
  /** Max ms to wait for a single embedding. */
  embedTimeoutMs?: number;
}

/** Worker body. Runs in an `eval:true` (CommonJS) worker so it needs no build
 *  step and no `.ts` loader. All package paths are resolved on the main thread
 *  and handed in via `workerData` (a bare specifier wouldn't resolve here). */
const WORKER_SRC = `
const { workerData, parentPort } = require('worker_threads');
const mod = require('module');
const { sync, textBuf, resultBuf, ortUrl, transformersUrl, wasmDir, modelId, dtype, dim } = workerData;

// Redirect transformers' static \`import 'onnxruntime-node'\` to an empty stub so
// its load never crashes on platforms without a native ORT prebuilt.
mod.register('data:text/javascript,' + encodeURIComponent(
  "export async function resolve(spec, ctx, next){ if (spec === 'onnxruntime-node') return { url: 'data:text/javascript,export default {};', shortCircuit: true }; return next(spec, ctx); }"
));

const s = new Int32Array(sync);
const tb = new Uint8Array(textBuf);
const rb = new Float32Array(resultBuf);
const dec = new TextDecoder();

(async () => {
  let extractor;
  try {
    const ortNs = await import(ortUrl);
    const ORT = ortNs.default ?? ortNs;
    ORT.env.wasm.numThreads = 1;
    ORT.env.wasm.proxy = false;
    ORT.env.wasm.wasmPaths = wasmDir;
    globalThis[Symbol.for('onnxruntime')] = ORT;

    const tf = await import(transformersUrl);
    const pipeline = tf.pipeline ?? (tf.default && tf.default.pipeline);
    const env = tf.env ?? (tf.default && tf.default.env);
    if (env) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      env.backends.onnx.wasm.wasmPaths = wasmDir;
    }
    extractor = await pipeline('feature-extraction', modelId, { dtype, device: 'wasm' });
    const probe = await extractor('probe', { pooling: 'mean', normalize: true });
    parentPort.postMessage({ ready: true, dim: probe.data.length });
  } catch (e) {
    parentPort.postMessage({ ready: false, error: String((e && e.stack) || e) });
    return;
  }

  for (;;) {
    Atomics.wait(s, ${REQ}, 0);
    Atomics.store(s, ${REQ}, 0);
    const len = Atomics.load(s, ${TLEN});
    const text = dec.decode(tb.subarray(0, len));
    try {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      const d = out.data;
      const n = Math.min(dim, d.length);
      for (let i = 0; i < n; i++) rb[i] = d[i];
      Atomics.store(s, ${RDIM}, n);
    } catch (e) {
      Atomics.store(s, ${RDIM}, -1);
    }
    Atomics.store(s, ${RESP}, 1);
    Atomics.notify(s, ${RESP});
  }
})();
`;

export class OnnxEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  private readonly modelId: string;
  private readonly dtype: string;
  private readonly embedTimeoutMs: number;
  private worker: Worker | null = null;
  private sync!: Int32Array;
  private textArr!: Uint8Array;
  private resultArr!: Float32Array;
  private readonly enc = new TextEncoder();

  constructor(opts: OnnxEmbedderOptions = {}) {
    this.modelId = opts.modelId ?? "Xenova/all-MiniLM-L6-v2";
    this.dtype = opts.dtype ?? "q8";
    this.dim = opts.dim ?? 384;
    this.id = opts.id ?? `onnx:${this.modelId}:${this.dtype}`;
    this.embedTimeoutMs = opts.embedTimeoutMs ?? 60_000;
  }

  /** Spawn the worker, load the model, and block (async) until it is ready.
   *  Rejects if transformers/ORT can't be resolved or the model fails to load. */
  async init(initTimeoutMs = 180_000): Promise<this> {
    const ortEntry = require.resolve("onnxruntime-web");
    const ortUrl = pathToFileURL(ortEntry).href;
    const wasmDir = pathToFileURL(join(dirname(ortEntry), "/")).href;
    // require.resolve gives the CJS entry; the ESM build lives beside it.
    const tfEntry = require.resolve("@huggingface/transformers");
    const transformersUrl = pathToFileURL(join(dirname(tfEntry), "transformers.node.mjs")).href;

    const syncSab = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
    const textSab = new SharedArrayBuffer(TEXT_CAP);
    const resultSab = new SharedArrayBuffer(this.dim * Float32Array.BYTES_PER_ELEMENT);
    this.sync = new Int32Array(syncSab);
    this.textArr = new Uint8Array(textSab);
    this.resultArr = new Float32Array(resultSab);

    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: {
        sync: syncSab,
        textBuf: textSab,
        resultBuf: resultSab,
        ortUrl,
        transformersUrl,
        wasmDir,
        modelId: this.modelId,
        dtype: this.dtype,
        dim: this.dim,
      },
    });
    // Don't keep the process alive on the worker's account; we terminate it in close().
    worker.unref();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`OnnxEmbedder: model load timed out after ${initTimeoutMs}ms`)), initTimeoutMs);
      timer.unref?.();
      worker.once("message", (m: { ready: boolean; dim?: number; error?: string }) => {
        clearTimeout(timer);
        if (!m.ready) return reject(new Error(`OnnxEmbedder: ${m.error ?? "model load failed"}`));
        if (m.dim !== this.dim) return reject(new Error(`OnnxEmbedder: model dim ${m.dim} != expected ${this.dim}`));
        resolve();
      });
      worker.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    this.worker = worker;
    return this;
  }

  embed(text: string): Float32Array {
    if (!this.worker) throw new Error("OnnxEmbedder.embed called before init()");
    const { written } = this.enc.encodeInto(text, this.textArr);
    Atomics.store(this.sync, TLEN, written ?? 0);
    Atomics.store(this.sync, RESP, 0);
    Atomics.store(this.sync, REQ, 1);
    Atomics.notify(this.sync, REQ);
    const status = Atomics.wait(this.sync, RESP, 0, this.embedTimeoutMs);
    if (status === "timed-out") throw new Error("OnnxEmbedder.embed timed out");
    const n = Atomics.load(this.sync, RDIM);
    if (n < 0) throw new Error("OnnxEmbedder.embed failed in worker");
    return this.resultArr.slice(0, this.dim);
  }

  close(): void {
    void this.worker?.terminate();
    this.worker = null;
  }
}

/** Construct + initialize an `OnnxEmbedder`. Rejects (so callers fall back to
 *  `HashingEmbedder`) if the model can't be fetched/loaded. */
export async function loadOnnxEmbedder(opts: OnnxEmbedderOptions = {}): Promise<OnnxEmbedder> {
  return new OnnxEmbedder(opts).init(opts.initTimeoutMs);
}

let _warm: Promise<Embedder> | null = null;

/** Load the learned embedder once per process and install it as the shared
 *  default (so `defaultEmbedder()` returns it everywhere thereafter). Idempotent;
 *  on failure the shared default is left as `HashingEmbedder` and the rejection
 *  is surfaced (callers typically catch + ignore). */
export function warmDefaultEmbedder(opts: OnnxEmbedderOptions = {}): Promise<Embedder> {
  if (!_warm) {
    _warm = loadOnnxEmbedder(opts)
      .then((e) => {
        setDefaultEmbedder(e);
        return e as Embedder;
      })
      .catch((err) => {
        _warm = null; // allow a later retry
        throw err;
      });
  }
  return _warm;
}
