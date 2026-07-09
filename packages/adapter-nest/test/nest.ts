// Fast structural check: build the nx/pnpm fixture with the Nest adapter active
// and assert the DI/route/module views and nest_pipeline_for against
// author-supplied expected constants. This is a pure static check — it does NOT
// boot Nest. The booted-runtime oracle that validates nest_pipeline_for against
// a real instantiated app lives in nest-runtime.e2e.ts (`pnpm test:nest:runtime`).
// Exits non-zero on any regression.
import { Store, buildSkeleton, registerAdapter } from "@codehead-pl/tsca-core";
import { nestAdapter } from "../src/index.ts";
import * as t from "../src/tools.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

registerAdapter(nestAdapter);

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
}

const store = new Store(join(tmpdir(), `nest-${process.pid}.db`));
const res = buildSkeleton(store, "fixtures/nest-monorepo");
console.log("skeleton:", res, "adapters:", store.getMeta("adapters"));

check("nest adapter active", store.getMeta("adapters") === '["nest"]');

// ---- routes --------------------------------------------------------------
const routes = t.nest_routes(store, {}) as { count: number; routes: Array<{ id: string; path: unknown }> };
check("3 routes discovered", routes.count === 3);
check("GET /users/:id present", routes.routes.some((r) => r.id === "nest:route:GET /users/:id"));

// ---- DI ------------------------------------------------------------------
const providers = t.nest_providers(store, {}) as { providers: Array<Record<string, any>> };
const byToken = (tok: string) => providers.providers.find((p) => p.token === tok);
check("6 provider bindings", providers.providers.length === 6);
check("USER_REPOSITORY → InMemoryUserRepository (useClass)", byToken("USER_REPOSITORY")?.provides?.name === "InMemoryUserRepository" && byToken("USER_REPOSITORY")?.providerType === "useClass");
check("USER_REPOSITORY injected into UsersService", byToken("USER_REPOSITORY")?.injectedInto?.[0]?.name === "UsersService");
check("APP_GUARD is a DI-global guard providing RolesGuard", byToken("APP_GUARD")?.appHook === "APP_GUARD" && byToken("APP_GUARD")?.provides?.name === "RolesGuard");
check("USERS_FEATURE_FLAGS is useFactory", byToken("USERS_FEATURE_FLAGS")?.providerType === "useFactory");
check("USERS_PAGE_SIZE is useValue", byToken("USERS_PAGE_SIZE")?.providerType === "useValue");

const injected = t.nest_injected_into(store, { symbol: "@fixture/api|src/prisma/prisma.service.ts|PrismaService" }) as unknown as { hits: Array<{ name: string }> };
check("PrismaService injected into UsersService", injected.hits.some((h) => h.name === "UsersService"));

// ---- module graph --------------------------------------------------------
const graph = t.nest_module_graph(store, {}) as { modules: Array<{ name: string; imports: string[] }> };
check("AppModule imports UsersModule", graph.modules.find((m) => m.name === "AppModule")?.imports?.includes("UsersModule") === true);

// ---- the acceptance case: GET /users/:id effective pipeline --------------
type El = { name: string; source: string; resolved: boolean };
const pf = t.nest_pipeline_for(store, { handler: "@fixture/api|src/users/users.controller.ts|UsersController.findOne" }) as {
  guards: El[]; pipes: El[]; complete: boolean; unresolved?: Array<{ name: string }>;
};
const guardSig = pf.guards.map((g) => `${g.name}@${g.source}${g.resolved ? "" : "?"}`);
console.log("\nGET /users/:id guards:", guardSig.join(" → "));
check("guard order = SomeGuard(bootstrap) → dynamicGuard(unresolved) → RolesGuard(di) → AuthGuard(controller)",
  JSON.stringify(guardSig) === JSON.stringify([
    "SomeGuard@global-bootstrap",
    "dynamicGuard@global-bootstrap?",
    "RolesGuard@global-di",
    "AuthGuard@controller",
  ]));
check("global ValidationPipe in the chain", pf.pipes.some((p) => p.name === "ValidationPipe" && p.source === "global-bootstrap"));
check("pipeline is honestly incomplete (dynamicGuard unresolved)", pf.complete === false && !!pf.unresolved?.some((u) => u.name === "dynamicGuard"));

// method-level guard stacks on the controller-level one
const pc = t.nest_pipeline_for(store, { handler: "@fixture/api|src/users/users.controller.ts|UsersController.create" }) as { guards: El[]; pipes: El[] };
check("POST /users: AuthGuard applied at both controller and method level",
  pc.guards.filter((g) => g.name === "AuthGuard").map((g) => g.source).sort().join(",") === "controller,method");

// ---- param-level pipes fold into the pipe stage ----------------------
// @Param('id', ParseIntPipe) — a bare class ref, resolves via DI, source:'param'.
const pipeSig = (p: { name: string; source: string; resolved: boolean; style?: string }) =>
  `${p.name}@${p.source}${p.resolved ? "" : "?"}`;
console.log("\nGET /users/:id pipes:", pf.pipes.map(pipeSig).join(" → "));
check("param pipe ParseIntPipe present, source:'param', resolved",
  pf.pipes.some((p) => p.name === "ParseIntPipe" && p.source === "param" && p.resolved === true));
check("param pipe runs at the pipe-stage tail (after global ValidationPipe)",
  pf.pipes.findIndex((p) => p.source === "param") === pf.pipes.length - 1 &&
  pf.pipes.findIndex((p) => p.name === "ValidationPipe" && p.source === "global-bootstrap") <
    pf.pipes.findIndex((p) => p.source === "param"));

// @Body(new ValidationPipe()) — inline instantiation, manual/no-DI (style:'new').
console.log("POST /users pipes:", pc.pipes.map(pipeSig).join(" → "));
check("param pipe from `new ValidationPipe()` present, source:'param', style:'new'",
  pc.pipes.some((p) => p.name === "ValidationPipe" && p.source === "param" && (p as { style?: string }).style === "new"));

// ---- GraphQL sub-adapter --------------------------------------------
// Detection flag is set (the api package depends on @nestjs/graphql). This is
// what the daemon gates the nest_graphql tool on in /manifest.
check("nest:graphql detection flag active", store.getMeta("nest:graphql") === "true");

type GqlOp = { field: string; returns: string | null; objectType: string | null; handler?: { name: string } | undefined; args: Array<{ name: string; in: string; key: string | null }>; dtos: Array<{ name?: string } | undefined> };
type GqlResolver = { name: string; objectType: string | null; resolver?: { name: string }; guards: string[]; queries: GqlOp[]; mutations: GqlOp[]; subscriptions: GqlOp[]; fields: GqlOp[] };
const gql = t.nest_graphql(store, {}) as unknown as { count: number; resolvers: GqlResolver[] };
console.log("\ngraphql resolvers:", gql.resolvers.map((r) => `${r.name}(${r.objectType})`).join(", "));
check("1 resolver discovered (UsersResolver on UserModel)", gql.count === 1 && gql.resolvers[0].name === "UsersResolver" && gql.resolvers[0].objectType === "UserModel");

const usersRes = gql.resolvers[0];
const listQuery = usersRes.queries.find((q) => q.field === "users");
check("query `users` returns [UserModel], handler symbol UsersResolver.users",
  listQuery?.returns === "[UserModel]" && listQuery?.handler?.name === "users");

const createMut = usersRes.mutations.find((m) => m.field === "createUser");
check("mutation `createUser` @Args('input') links to CreateUserInput DTO",
  createMut?.returns === "UserModel" &&
  createMut?.args.some((a) => a.in === "args" && a.key === "input") === true &&
  createMut?.dtos.some((d) => d?.name === "CreateUserInput") === true);

// @ResolveField field resolver present, with its parent object type.
const fieldOp = usersRes.fields.find((f) => f.field === "posts");
check("field resolver `posts` present: returns [PostModel], parent objectType UserModel, handler UsersResolver.posts",
  fieldOp?.returns === "[PostModel]" && fieldOp?.objectType === "UserModel" && fieldOp?.handler?.name === "posts");

// `kind` filter narrows to a single facet (flat list of ops).
const onlyFields = t.nest_graphql(store, { kind: "field" }) as unknown as { kind: string; count: number; ops: GqlOp[] };
check("nest_graphql({kind:'field'}) returns only field resolvers", onlyFields.count === 1 && onlyFields.ops[0].field === "posts");

// ---- nest_pipeline_for composes a resolver's guard chain -------------
// Guards/interceptors/filters apply to resolvers via the GraphQL execution
// context. The resolver plays the "controller" role: its class-level
// @UseGuards(AuthGuard) stacks under the global levels, exactly like a route.
const rp = t.nest_pipeline_for(store, { handler: "@fixture/api|src/graphql/users.resolver.ts|UsersResolver.users" }) as {
  guards: El[]; graphql?: { field: string }; complete: boolean;
};
const rGuardSig = rp.guards.map((g) => `${g.name}@${g.source}${g.resolved ? "" : "?"}`);
console.log("resolver `users` guards:", rGuardSig.join(" → "));
check("resolver guard chain = SomeGuard(bootstrap) → dynamicGuard(unresolved) → RolesGuard(di) → AuthGuard(resolver)",
  JSON.stringify(rGuardSig) === JSON.stringify([
    "SomeGuard@global-bootstrap",
    "dynamicGuard@global-bootstrap?",
    "RolesGuard@global-di",
    "AuthGuard@controller",
  ]));
check("pipeline_for on a resolver surfaces the graphql op descriptor", rp.graphql?.field === "users");

// ---- messaging sub-adapter -----------------------------------------
// Detection flag is set (the api package depends on @nestjs/microservices +
// @nestjs/bullmq). This is what the daemon gates nest_messaging on in /manifest.
check("nest:messaging detection flag active", store.getMeta("nest:messaging") === "true");

type MsgHandler = { messagingKind: string; transport: string | null; pattern: string | null; queue: string | null; jobName: string | null; handler?: { name: string }; payload: string | null; dtos: Array<{ name?: string } | undefined> };
type MsgConsumer = { name: string; transport: string; queue: string | null; consumer?: { name: string }; guards: string[]; messages: MsgHandler[]; events: MsgHandler[]; processes: MsgHandler[] };
const msg = t.nest_messaging(store, {}) as unknown as { count: number; consumers: MsgConsumer[] };
console.log("\nmessaging consumers:", msg.consumers.map((c) => `${c.name}(${c.transport}${c.queue ? ":" + c.queue : ""})`).join(", "));
check("2 consumers discovered (MathController rpc + EmailProcessor bull)", msg.count === 2);

const math = msg.consumers.find((c) => c.name === "MathController");
const sumMsg = math?.messages.find((h) => h.pattern === "sum");
check("@MessagePattern('sum', Transport.TCP): transport TCP, payload SumPayload DTO, handler accumulate",
  sumMsg?.messagingKind === "message" && sumMsg?.transport === "Transport.TCP" &&
  sumMsg?.handler?.name === "accumulate" && sumMsg?.dtos.some((d) => d?.name === "SumPayload") === true);

const evt = math?.events.find((h) => h.pattern === "user.created");
check("@EventPattern('user.created'): event kind, payload UserCreatedEvent DTO, handler handleUserCreated",
  evt?.messagingKind === "event" && evt?.handler?.name === "handleUserCreated" &&
  evt?.dtos.some((d) => d?.name === "UserCreatedEvent") === true);

const email = msg.consumers.find((c) => c.name === "EmailProcessor");
const proc = email?.processes.find((h) => h.jobName === "send");
check("BullMQ @Processor('email') + @Process('send'): queue email, job send, Job<EmailJob> unwrapped to EmailJob DTO",
  email?.transport === "bull" && email?.queue === "email" && proc?.messagingKind === "process" &&
  proc?.handler?.name === "sendEmail" && proc?.dtos.some((d) => d?.name === "EmailJob") === true);

// `kind` filter narrows to a single facet (flat list of handlers).
const onlyProc = t.nest_messaging(store, { kind: "process" }) as unknown as { kind: string; count: number; handlers: MsgHandler[] };
check("nest_messaging({kind:'process'}) returns only BullMQ processors", onlyProc.count === 1 && onlyProc.handlers[0].jobName === "send");

// Entrypoints: @EventPattern → event-handler; @MessagePattern + BullMQ → queue-consumer.
check("queue-consumer + event-handler entrypoints populated for messaging handlers",
  store.listEntrypoints("queue-consumer").filter((e) => e.source === "nest").length === 2 &&
  store.listEntrypoints("event-handler").filter((e) => e.source === "nest").length === 1);

// ---- nest_pipeline_for composes a message handler's guard chain -----
// Guards apply to message handlers via the RPC/queue execution context. The
// consumer class plays the "controller" role: its class-level @UseGuards(AuthGuard)
// stacks under the global levels, exactly like a route or resolver.
const mp = t.nest_pipeline_for(store, { handler: "@fixture/api|src/messaging/math.controller.ts|MathController.accumulate" }) as {
  guards: El[]; messaging?: { kind: string; pattern: string | null }; complete: boolean;
};
const mGuardSig = mp.guards.map((g) => `${g.name}@${g.source}${g.resolved ? "" : "?"}`);
console.log("message handler `accumulate` guards:", mGuardSig.join(" → "));
check("message handler guard chain = SomeGuard(bootstrap) → dynamicGuard(unresolved) → RolesGuard(di) → AuthGuard(consumer)",
  JSON.stringify(mGuardSig) === JSON.stringify([
    "SomeGuard@global-bootstrap",
    "dynamicGuard@global-bootstrap?",
    "RolesGuard@global-di",
    "AuthGuard@controller",
  ]));
check("pipeline_for on a message handler surfaces the messaging descriptor",
  mp.messaging?.kind === "message" && mp.messaging?.pattern === "sum");

// ---- nest_graphql is absent in a non-GraphQL project ----------------
// Build a minimal Nest project WITHOUT @nestjs/graphql: the detection flag must
// stay unset (so /manifest hides nest_graphql) and no resolver fragments exist.
const plainRoot = mkdtempSync(join(tmpdir(), "nest-plain-"));
mkdirSync(join(plainRoot, "src"), { recursive: true });
writeFileSync(join(plainRoot, "package.json"), JSON.stringify({
  name: "plain-api", version: "0.0.1",
  dependencies: { "@nestjs/common": "^10.3.0", "@nestjs/core": "^10.3.0" },
}));
writeFileSync(join(plainRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { experimentalDecorators: true } }));
writeFileSync(join(plainRoot, "src/cats.controller.ts"),
  "import { Controller, Get } from '@nestjs/common';\n@Controller('cats')\nexport class CatsController {\n  @Get()\n  findAll() { return []; }\n}\n");
const plain = new Store(join(tmpdir(), `nest-plain-${process.pid}.db`));
buildSkeleton(plain, plainRoot);
check("non-GraphQL project: nest adapter active but nest:graphql flag unset",
  plain.getMeta("adapters") === '["nest"]' && plain.getMeta("nest:graphql") === null);
const plainGql = t.nest_graphql(plain, {}) as { count: number };
check("non-GraphQL project: nest_graphql returns no resolvers", plainGql.count === 0);
// The same plain project has no messaging deps either — the nest:messaging flag
// must stay unset and nest_messaging must return nothing (detection-gated).
check("non-messaging project: nest:messaging flag unset", plain.getMeta("nest:messaging") === null);
const plainMsg = t.nest_messaging(plain, {}) as { count: number };
check("non-messaging project: nest_messaging returns no consumers", plainMsg.count === 0);
plain.close();

store.close();
console.log(failures === 0 ? "\nPASS — all Nest acceptance checks green" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
