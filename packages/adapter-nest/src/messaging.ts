// Nest messaging sub-adapter. Gated on
// `@nestjs/microservices` and/or BullMQ (`@nestjs/bullmq` / `@nestjs/bull` /
// `bullmq` / `bull`) in the package's deps. Like the rest of the Nest adapter
// this is decorator-structural (no Tier-2): it reads `@MessagePattern` /
// `@EventPattern` (microservices) and `@Processor` / `@Process` (BullMQ) off
// classes already parsed by core pass 1 and emits `nest:messaging` fragments:
//   - `messaging-controller` — a class hosting message/event handlers (RPC) or a
//                              BullMQ `@Processor(queue)` consumer, with its
//                              class-level @UseGuards/etc. pipeline.
//   - `messaging-handler`    — a `@MessagePattern`/`@EventPattern` method
//                              (transport, pattern/topic, payload DTO, handler
//                              symbol) or a BullMQ `@Process(job?)` method (queue,
//                              job name, `Job<T>` payload DTO).
// Decorator origin is verified against the messaging import so a user-defined
// `@Process` never masquerades. `queue-consumer` / `event-handler` entrypoints
// are populated per handler; pipeline composition (nest_pipeline_for) accepts a
// message handler — the consumer class plays the "controller" role in the
// RPC/queue execution context, reading the same pipeline refs the routes use.
import {
  Node,
  type ClassDeclaration,
  type Decorator,
  type MethodDeclaration,
  type ParameterDeclaration,
  type SourceFile,
} from "ts-morph";
import type { AdapterContext, FragmentNodeRecord } from "@tsca/core";
import {
  buildImportMap,
  firstStringArg,
  mergePipelineRefs,
  nonExternal,
  pipelineRefsOf,
  propInit,
  spanOf,
} from "./build.ts";

// Message-pattern decorator → the `messagingKind` recorded on the fragment.
const MICRO_KIND: Record<string, "message" | "event"> = {
  MessagePattern: "message",
  EventPattern: "event",
};

interface MsgPayload {
  payload: string | null; // the param type text (e.g. "Job<EmailJob>")
  dto: string | null; // resolved payload DTO SymbolId
}

/** Emit `nest:messaging` fragments for one package. Returns true when at least
 *  one message/event handler or BullMQ processor was found (so the caller can set
 *  the detection flag). */
export function buildMessaging(ctx: AdapterContext): boolean {
  const files = ctx.project.getSourceFiles().filter((sf) => ctx.inPackage(sf));
  const importMaps = new Map<SourceFile, Map<string, string>>();
  const origin = (sf: SourceFile, name: string): string => {
    let m = importMaps.get(sf);
    if (!m) {
      m = buildImportMap(sf);
      importMaps.set(sf, m);
    }
    return m.get(name) ?? "";
  };
  const isMicro = (sf: SourceFile, name: string): boolean => origin(sf, name).startsWith("@nestjs/microservices");
  const isBull = (sf: SourceFile, name: string): boolean => {
    const o = origin(sf, name);
    return o.startsWith("@nestjs/bull") || o === "bull" || o === "bullmq";
  };
  const sym = (node: Node): string | undefined => ctx.symbolIdOf(node);
  const isClassSym = (id: string): boolean => ctx.index.info.get(id)?.kind === "class";

  let found = false;
  for (const sf of files) {
    for (const cls of sf.getClasses()) {
      const processorDec = cls.getDecorator("Processor");
      const isBullProcessor = !!processorDec && isBull(sf, "Processor");
      // A microservices controller is any class carrying at least one
      // @MessagePattern/@EventPattern method resolved from @nestjs/microservices.
      const hasMicro = cls.getMethods().some((m) => m.getDecorators().some((d) => MICRO_KIND[d.getName()] && isMicro(sf, d.getName())));
      if (!isBullProcessor && !hasMicro) continue;
      found = true;
      emitConsumer(ctx, cls, sf, { isMicro, isBull, isBullProcessor, processorDec, sym, isClassSym });
    }
  }
  return found;
}

interface EmitCtx {
  isMicro: (sf: SourceFile, name: string) => boolean;
  isBull: (sf: SourceFile, name: string) => boolean;
  isBullProcessor: boolean;
  processorDec: Decorator | undefined;
  sym: (node: Node) => string | undefined;
  isClassSym: (id: string) => boolean;
}

function emitConsumer(ctx: AdapterContext, cls: ClassDeclaration, sf: SourceFile, e: EmitCtx): void {
  const clsId = e.sym(cls);
  if (!clsId) return;
  const fid = ctx.fileIdOf(sf);
  const resolve = ctx.resolveName(sf);
  const name = cls.getName() ?? "default";
  const transport = e.isBullProcessor ? "bull" : "rpc";
  const queue = e.isBullProcessor && e.processorDec ? processorQueue(e.processorDec) : null;

  // Consumer-class-level pipeline (@UseGuards on the class) — the consumer plays
  // the "controller" role for pipeline composition (RPC/queue exec context).
  const clsPipeline = pipelineRefsOf(cls, resolve, e.isClassSym);
  const clsRefs: FragmentNodeRecord["refs"] = { consumer: clsId };
  mergePipelineRefs(clsRefs, clsPipeline);

  let handlerCount = 0;
  for (const m of cls.getMethods()) {
    const microDec = m.getDecorators().find((d) => MICRO_KIND[d.getName()] && e.isMicro(sf, d.getName()));
    const processDec = e.isBullProcessor ? m.getDecorators().find((d) => d.getName() === "Process" && e.isBull(sf, "Process")) : undefined;
    if (!microDec && !processDec) continue;
    handlerCount += 1;

    const handlerId = e.sym(m);
    const { payload, dto } = messagingPayload(m, resolve);
    const opPipeline = pipelineRefsOf(m, resolve, e.isClassSym);
    const refs: FragmentNodeRecord["refs"] = { consumer: clsId };
    if (handlerId) refs.handler = handlerId;
    if (dto) refs.dto = dto;
    mergePipelineRefs(refs, opPipeline);

    const messagingKind = microDec ? MICRO_KIND[microDec.getName()] : "process";
    const pattern = microDec ? patternText(microDec) : null;
    const microTransport = microDec ? transportText(microDec) : null;
    const jobName = processDec ? processJobName(processDec) : null;

    const handlerId2 = `nest:messaging:${messagingKind}:${name}.${m.getName()}`;
    ctx.store.upsertFragment({
      id: handlerId2,
      adapter: "nest",
      kind: "messaging-handler",
      attrs: {
        messagingKind,
        transport: microTransport ?? transport,
        pattern,
        queue,
        jobName,
        consumer: name,
        handler: m.getName(),
        payload,
        unresolvedPipeline: [...clsPipeline.unresolved, ...opPipeline.unresolved],
      },
      refs,
      span: spanOf(m),
      provenance: fid ? [fid] : [],
    });

    if (handlerId && fid) {
      // @EventPattern → event-handler; @MessagePattern + BullMQ @Process →
      // queue-consumer (both consume off a transport/queue). These entrypoint
      // kinds already exist in the core union.
      const epKind = messagingKind === "event" ? "event-handler" : "queue-consumer";
      const epId =
        messagingKind === "process"
          ? `queue-consumer:${queue ?? "?"}.${jobName ?? "*"}`
          : `${epKind}:${messagingKind} ${pattern ?? m.getName()}`;
      ctx.store.upsertEntrypoint({
        id: epId,
        kind: epKind,
        source: "nest",
        symbol: handlerId,
        detail: { messagingKind, transport: microTransport ?? transport, pattern, queue, jobName, consumer: name },
        file: fid,
      });
    }
  }

  ctx.store.upsertFragment({
    id: `nest:messaging:consumer:${name}`,
    adapter: "nest",
    kind: "messaging-controller",
    attrs: { name, transport, queue, handlerCount, unresolvedPipeline: clsPipeline.unresolved },
    refs: clsRefs,
    span: spanOf(cls),
    provenance: fid ? [fid] : [],
  });
}

// ---- messaging AST helpers ----------------------------------------------

/** Pattern/topic of a `@MessagePattern`/`@EventPattern`: a string literal's value,
 *  else the raw text of an object/identifier pattern (`{ cmd: 'sum' }`). */
function patternText(dec: Decorator): string | null {
  const a = dec.getArguments()[0];
  if (!a) return null;
  if (Node.isStringLiteral(a)) return a.getLiteralValue();
  return a.getText();
}

/** The transport of a message/event pattern: the second decorator arg
 *  (`Transport.TCP`, a client token), else null (default transport). */
function transportText(dec: Decorator): string | null {
  const a = dec.getArguments()[1];
  return a ? a.getText() : null;
}

/** Queue name of a BullMQ `@Processor('email')` / `@Processor({ name: 'email' })`. */
function processorQueue(dec: Decorator): string | null {
  const a = dec.getArguments()[0];
  if (!a) return null;
  if (Node.isStringLiteral(a)) return a.getLiteralValue();
  if (Node.isObjectLiteralExpression(a)) {
    const n = propInit(a, "name");
    if (n && Node.isStringLiteral(n)) return n.getLiteralValue();
  }
  return null;
}

/** Job name of a BullMQ `@Process('send')` / `@Process({ name: 'send' })`; null
 *  means the processor handles every job on its queue. */
function processJobName(dec: Decorator): string | null {
  const explicit = firstStringArg(dec);
  if (explicit) return explicit;
  const a = dec.getArguments()[0];
  if (a && Node.isObjectLiteralExpression(a)) {
    const n = propInit(a, "name");
    if (n && Node.isStringLiteral(n)) return n.getLiteralValue();
  }
  return null;
}

/** The handler's payload: the `@Payload()`-decorated param (microservices), else
 *  the first param. Records the raw type text and resolves the payload DTO —
 *  unwrapping a BullMQ `Job<T>` to `T` (the job's data type). */
function messagingPayload(m: MethodDeclaration, resolve: (n: string) => string | null): MsgPayload {
  const params = m.getParameters();
  const target =
    params.find((p) => p.getDecorators().some((d) => d.getName() === "Payload")) ??
    params.find((p) => p.getDecorators().length === 0) ??
    params[0];
  if (!target) return { payload: null, dto: null };
  const payload = target.getTypeNode()?.getText() ?? null;
  const head = payloadTypeHead(target);
  const dto = head ? nonExternal(resolve(head)) : null;
  return { payload, dto };
}

/** Head identifier of a payload param type, unwrapping `Job<T>` → head of `T`
 *  and stripping any remaining generics/qualifiers. */
function payloadTypeHead(p: ParameterDeclaration): string | null {
  const t = p.getTypeNode()?.getText();
  if (!t) return null;
  const job = t.match(/^Job\s*<\s*([\s\S]+)>\s*$/);
  const base = job ? job[1].trim() : t;
  const noGenerics = base.replace(/<[\s\S]*>/, "").trim();
  const seg = noGenerics.split(".").pop() ?? noGenerics;
  const mm = seg.match(/[A-Za-z0-9_$]+/);
  return mm ? mm[0] : null;
}
