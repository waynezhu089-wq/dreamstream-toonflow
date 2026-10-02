const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
const { generateObject } = require('ai');
const { z } = require('zod');

test('installed OpenAI-compatible adapter sends a multimodal image as image_url data URL', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=';
  let request;
  const provider = createOpenAICompatible({
    name: 'local-wire-capture', baseURL: 'https://example.invalid/v1', apiKey: 'local-test-only',
    fetch: async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'local-only', object: 'chat.completion', created: 1, model: 'wire-test',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"summary":"A small image"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await generateObject({
    model: provider.chatModel('wire-test'), schema: z.object({ summary: z.string() }),
    system: 'Return JSON only.',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Describe the image as JSON.' },
      { type: 'image', image: Buffer.from(png, 'base64'), mediaType: 'image/png' },
    ] }],
  });
  assert.equal(result.object.summary, 'A small image');
  const imagePart = request.messages.find(message => message.role === 'user').content.find(part => part.type === 'image_url');
  assert.deepEqual(imagePart, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } });
});
