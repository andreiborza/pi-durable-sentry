// Checks if `runs.owners` keeps traces alive. Run with:
//   node --expose-gc --import ./instrument-leak.mjs leak.mjs [orphan|control] [iterations]
//
// Each iteration is one run in a new conversation. The model calls `spawn`, which fails:
// - orphan:  `spawn` creates a task-owned conversation first, so `owners` gets an entry that is never used
//            (the child never runs);
// - control: `spawn` fails without creating a conversation.
import * as Sentry from '@sentry/node';
import { spanToJSON } from '@sentry/core';
import { tracingChannel } from 'node:diagnostics_channel';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from '@earendil-works/pi-durable';

const mode = process.argv[2] ?? 'orphan';
const iterations = Number(process.argv[3] ?? 1200);
const context = BACKGROUND_CONTEXT;
// Recorded on every chat span as `gen_ai.system_instructions`, so a retained trace has a visible cost.
const INSTRUCTIONS = `You are a test agent. ${'x'.repeat(20_000)}`;

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run with --expose-gc');
}

// Every root span, held weakly: a root that survives GC is a retained trace.
const roots = [];
Sentry.getClient().on('spanStart', span => {
  const json = spanToJSON(span);
  // Span streaming puts the op in the attributes.
  if ((json.op ?? json.attributes?.['sentry.op']) === 'gen_ai.invoke_agent' && !json.parent_span_id) {
    roots.push(new WeakRef(span));
  }
});

// Test-only access to the integration's per-Harness state, to read the map sizes.
let runs;
tracingChannel('orchestrion:@earendil-works/pi-durable:harnessOpen').subscribe({
  start() {},
  end() {},
  asyncStart() {},
  error() {},
  asyncEnd(message) {
    runs = message.arguments[1][Symbol.for('sentry.pi-durable.runs')];
  },
});

const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(
  Array.from({ length: iterations * 2 + 10 }, () => transcript =>
    transcript.messages.at(-1).role === 'toolResult'
      ? fauxAssistantMessage('The spawn failed.')
      : fauxAssistantMessage(fauxToolCall('spawn', {}, { id: 'call_spawn' }), { stopReason: 'toolUse' }),
  ),
);

const registry = createRegistry();
registry.install(
  defineExtension({
    name: 'app',
    tools: [
      defineTool({
        name: 'spawn',
        description: 'Starts a subagent.',
        parameters: Type.Object({}),
        execute: async (_args, api, toolContext) => {
          if (mode === 'orphan') {
            await api.commit(tx => tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } }), toolContext);
          }
          throw new Error('Subagent failed to start');
        },
      }),
    ],
  }),
);

const model = { provider: 'faux', modelId: 'faux-model' };

async function collect() {
  // Span streaming buffers traces until a flush; without one, the buffer looks like a leak.
  await Sentry.flush(2000);
  for (let i = 0; i < 5; i++) {
    globalThis.gc();
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function report(label) {
  await collect();
  const alive = roots.filter(ref => ref.deref()).length;
  const heapMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const owners = runs ? runs.owners.size : '-';
  const active = runs ? runs.active.size : '-';
  const toolCalls = runs ? runs.toolCalls.size : '-';
  console.log(
    `${label.padEnd(22)} roots alive: ${String(alive).padStart(5)} / ${roots.length}  heap: ${heapMb.padStart(7)} MB  owners: ${owners}  active: ${active}  toolCalls: ${toolCalls}`,
  );
}

console.log(`mode=${mode} iterations=${iterations}`);
let harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
await report('after open');

const started = Date.now();
for (let i = 1; i <= iterations; i++) {
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model, instructions: INSTRUCTIONS } }, context);
  await (await conversation.submit({ type: 'input', content: `Run ${i}` }, context)).wait(context);
  if (i % 300 === 0) {
    await report(`after ${i} runs`);
  }
}
console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);

await harness.waitForIdle(context);
await harness.close(context);
// Dropping `harness` frees nothing here, even in control mode: pi-durable keeps a closed Harness alive.
await report('after close');
