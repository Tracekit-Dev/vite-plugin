# @tracekit/vite-plugin

TraceKit source map upload plugin for Vite. Automatically uploads source maps during your build for server-side symbolication of production errors.

## Installation

```bash
npm install @tracekit/vite-plugin --save-dev
```

## Quick Start

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { traceKitVitePlugin } from '@tracekit/vite-plugin';

export default defineConfig({
  plugins: [
    traceKitVitePlugin({
      apiKey: 'your-api-key',
      org: 'your-org',
      project: 'your-project',
    }),
  ],
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | Required | Your TraceKit API key |
| `org` | `string` | Required | Organization slug |
| `project` | `string` | Required | Project slug |
| `include` | `string` | `'dist/**/*.js'` | Glob pattern for files to upload |
| `dryRun` | `boolean` | `false` | Validate without uploading |

## Documentation

Full documentation: https://app.tracekit.dev/docs/frontend/source-maps

## License

MIT
