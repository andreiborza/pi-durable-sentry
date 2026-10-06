import * as Sentry from '@sentry/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from '@earendil-works/pi-durable';

const context = BACKGROUND_CONTEXT;
const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);

const models = createModels();
let model;
if (useOpenRouter) {
  models.setProvider(openrouterProvider());
  model = { provider: 'openrouter', modelId: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4.1-mini' };
} else {
  // Offline: answers are derived from the transcript, so every conversation (subagents too) gets one.
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 20 }, () => fauxRespond));
  model = { provider: 'faux', modelId: 'faux-model' };
}

function fauxRespond(transcript) {
  const lastUser = [...transcript.messages].reverse().find(message => message.role === 'user');
  const text = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.map(p => p.text).join('');
  if (transcript.messages.at(-1).role === 'toolResult') {
    return fauxAssistantMessage(`Done: ${text}`);
  }
  if (/weather/i.test(text) && !/subagent/i.test(text)) {
    return fauxAssistantMessage(fauxToolCall('get_weather', { city: 'Vienna' }, { id: 'call_weather' }), {
      stopReason: 'toolUse',
    });
  }
  if (/subagent/i.test(text)) {
    return fauxAssistantMessage(fauxToolCall('delegate', { task: 'What is the weather in Paris?' }, { id: 'call_delegate' }), {
      stopReason: 'toolUse',
    });
  }
  if (/inventory/i.test(text)) {
    return fauxAssistantMessage(fauxToolCall('check_inventory', { sku: 'ABC-123' }, { id: 'call_inventory' }), {
      stopReason: 'toolUse',
    });
  }
  return fauxAssistantMessage(`Answer: ${text}`);
}

const registry = createRegistry();
registry.install(
  defineExtension({
    name: 'app',
    tools: [
      defineTool({
        name: 'get_weather',
        description: 'Returns the current weather for a city.',
        parameters: Type.Object({ city: Type.String() }),
        execute: async ({ city }) => ({ content: [{ type: 'text', text: `${city}: 21°C, sunny` }] }),
      }),
      defineTool({
        name: 'check_inventory',
        description: 'Returns the stock level of a product SKU.',
        parameters: Type.Object({ sku: Type.String() }),
        execute: async ({ sku }) => {
          throw new Error(`Inventory service unavailable for ${sku}`);
        },
      }),
      defineTool({
        name: 'delegate',
        description: 'Gives a task to a subagent and returns its answer.',
        parameters: Type.Object({ task: Type.String() }),
        execute: async ({ task }, api, toolContext) => {
          const childId = await api.commit(
            async tx => (await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })).id,
            toolContext,
          );
          const child = await api.conversation(childId, toolContext);
          const settled = await (await child.submit({ type: 'input', content: task }, toolContext)).wait(toolContext);
          const answer = await api.commit(tx => tx.entry(AssistantEntry, settled.answer), toolContext);
          const text = (answer?.model?.[0]?.content ?? [])
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('');
          return { content: [{ type: 'text', text }] };
        },
      }),
    ],
  }),
);

const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, {
  agent: {
    model,
    instructions: 'You are a shop assistant. Always use the tools to answer. Keep answers short.',
  },
});

const inputs = [
  'What is the weather in Vienna?',
  'Check the inventory for SKU ABC-123.',
  'Ask a subagent: what is the weather in Paris?',
];

console.log(`Using ${model.provider}/${model.modelId}`);
for (const content of inputs) {
  const settled = await (await root.submit({ type: 'input', content }, context)).wait(context);
  console.log(`> ${content}\n  settled: ${settled.status}`);
}

await harness.waitForIdle(context);
await harness.close(context);
await Sentry.flush(5000);
console.log('Flushed to Sentry.');
