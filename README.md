# pi-durable-sentry

Test app for [getsentry/sentry-javascript#24993](https://github.com/getsentry/sentry-javascript/pull/24993) (pi-durable instrumentation). The leak report is in [report.md](report.md).

## Setup

The app links the local SDK build. It expects this folder layout:

```
<parent>/
  sentry-javascript/          # checkout of the PR branch
  experiments/pi-durable-sentry/
```

If your layout is different, change the `link:` paths in `package.json`.

```
# in sentry-javascript, on the PR branch
yarn install && yarn build:dev:filter @sentry/node

# in this folder (Node >= 22.19, pinned to 24.21.0 with Volta)
yarn install
cp .env.example .env    # set SENTRY_DSN, and optionally OPENROUTER_API_KEY
```

## Run the example app

```
yarn start
```

It submits three inputs: a tool call, a tool that throws, and a subagent. With `OPENROUTER_API_KEY` set, it uses OpenRouter. If not, it uses the offline `faux` provider.

## Run the leak test

Sends nothing to Sentry and uses `faux`.

```
node --expose-gc --import ./instrument-leak.mjs leak.mjs orphan 1200
node --expose-gc --import ./instrument-leak.mjs leak.mjs control 1200
```

See the Reproduction section of [report.md](report.md) for the expected output.
