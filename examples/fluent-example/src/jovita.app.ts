import { defineApp, provider } from '@jovita-ai/sdk';
import { z } from 'zod';

const example = provider({
  name: 'Example API', baseUrl: 'https://api.example.com', auth: 'bearer',
  docsUrl: 'https://api.example.com/docs', category: 'search',
});

export default defineApp({
  id: 'fluent-example', name: 'Fluent Example', version: '0.1.0',
  tools: {
    lookup: example.post('/lookup', {
      description: 'Look up one query',
      input: z.object({ query: z.string().min(1) }),
      output: z.object({ answer: z.string() }),
      creditsPerCall: 10,
    }),
  },
});
