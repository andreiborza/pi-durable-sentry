import * as Sentry from '@sentry/node';

// Spans must be sampled to be built like in production, but nothing is sent: thousands of runs would
// flood the project.
Sentry.init({
  dsn: 'https://public@dsn.ingest.sentry.io/1337',
  tracesSampleRate: 1.0,
  transport: () => ({ send: async () => ({}), flush: async () => true }),
});
