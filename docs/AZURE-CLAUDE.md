# Azure Claude Integration

This document explains how NanoClaw integrates with Azure's Claude API endpoint for cost savings.

## Overview

NanoClaw supports routing Claude API requests through Azure's managed Anthropic endpoint instead of calling Anthropic directly. This provides cost savings through Azure's pricing model while maintaining full compatibility with the Claude Agent SDK.

**Key insight**: Azure's Anthropic-compatible endpoint accepts the standard `x-api-key` header format natively, so no special proxy or header conversion is needed.

## Architecture

The implementation uses **environment variable redirection** rather than a middleware proxy:

```
┌─────────────────────────────────────────────────────────────┐
│  NanoClaw Host Process                                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  .env Configuration                                   │    │
│  │  AZURE_CLAUDE_ENDPOINT=https://...azure.com/anthropic │    │
│  │  ANTHROPIC_API_KEY=<azure-api-key>                   │    │
│  │  AZURE_MODEL=claude-sonnet-4-5                        │    │
│  └─────────────────────────────────────────────────────┘    │
│           │                                                   │
│           │ Injects into container                           │
│           ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Agent Container                                      │    │
│  │  ENV:                                                 │    │
│  │    ANTHROPIC_BASE_URL=https://...azure.com/anthropic │    │
│  │    ANTHROPIC_API_KEY=<azure-api-key>                 │    │
│  │    CLAUDE_MODEL=claude-sonnet-4-5                    │    │
│  │                                                       │    │
│  │  ┌─────────────────────────────────────────────┐    │    │
│  │  │  Claude Agent SDK                            │    │    │
│  │  │  - Reads ANTHROPIC_BASE_URL                 │    │    │
│  │  │  - Uses ANTHROPIC_API_KEY in x-api-key      │    │    │
│  │  │  - Sends requests with forced model name    │    │    │
│  │  └─────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                        │
                        │ HTTPS Request
                        │ Header: x-api-key: <azure-api-key>
                        ▼
          ┌──────────────────────────────────┐
          │  Azure Anthropic Endpoint         │
          │  ekatra-bots.services.ai.azure.com│
          │  - Accepts native x-api-key       │
          │  - Returns Claude responses       │
          └──────────────────────────────────┘
```

## Implementation Components

### 1. Environment Configuration (`.env`)

```dotenv
# Azure Claude Integration
AZURE_CLAUDE_ENDPOINT=https://ekatra-bots.services.ai.azure.com/anthropic
ANTHROPIC_API_KEY=<your-azure-api-key>
AZURE_MODEL=claude-sonnet-4-5
```

**Important**: When `AZURE_CLAUDE_ENDPOINT` is set, the `ANTHROPIC_API_KEY` should be your **Azure API key**, not your Anthropic API key.

### 2. Container Environment Injection

Location: [`src/container-runner.ts`](../src/container-runner.ts)

```typescript
if (process.env.AZURE_CLAUDE_ENDPOINT) {
  // Redirect Claude SDK to Azure endpoint
  args.push('-e', `ANTHROPIC_BASE_URL=${process.env.AZURE_CLAUDE_ENDPOINT}`);
  
  // Force specific model name (Azure deployment)
  const azureModel = process.env.AZURE_MODEL ?? 'claude-sonnet-4-5';
  args.push('-e', `CLAUDE_MODEL=${azureModel}`);
  
  logger.info({ containerName, model: azureModel }, 
    'Injecting ANTHROPIC_BASE_URL from AZURE_CLAUDE_ENDPOINT');
}
```

This code:
- Passes `ANTHROPIC_BASE_URL` to redirect the Claude SDK
- Injects `CLAUDE_MODEL` to force Azure's deployment name
- Logs the configuration for debugging

### 3. Model Forcing in Agent

Location: [`container/agent-runner/src/index.ts`](../container/agent-runner/src/index.ts)

```typescript
// Hard-pin model at runtime to avoid stale resumed-session model selection
const forcedModel = process.env.CLAUDE_MODEL || process.env.AZURE_MODEL;

for await (const message of query({
  prompt: stream,
  options: {
    model: forcedModel,  // Forces Azure deployment name
    // ...other options
  }
}))
```

This ensures every API request uses Azure's specific deployment name, even when resuming sessions.

### 4. Preflight Validation

Location: [`src/preflight.ts`](../src/preflight.ts)

```typescript
const hasAzureEndpoint = Boolean(process.env.AZURE_CLAUDE_ENDPOINT);

if (hasAzureEndpoint) {
  credentialMode = 'direct-azure';
  const model = process.env.AZURE_MODEL ?? process.env.CLAUDE_MODEL;
  if (!model) {
    failures.push(
      'AZURE_CLAUDE_ENDPOINT is set but AZURE_MODEL is missing. ' +
      'Add AZURE_MODEL=claude-sonnet-4-5 to .env'
    );
  }
  logger.info(
    { endpoint: process.env.AZURE_CLAUDE_ENDPOINT, model },
    'Preflight: using Azure direct credential mode'
  );
}
```

The preflight check:
- Detects Azure mode
- Validates required configuration
- Sets credential mode to `direct-azure`
- Fails startup if misconfigured

## How It Works

1. **Claude Agent SDK** is initialized in the container
2. It reads `ANTHROPIC_BASE_URL` from environment (set to Azure endpoint)
3. It reads `ANTHROPIC_API_KEY` from environment (your Azure key)
4. When making requests:
   - SDK sends to Azure endpoint instead of `api.anthropic.com`
   - Uses native `x-api-key` header (Azure accepts this format)
   - Includes forced model name (`claude-sonnet-4-5`)
5. Azure's Anthropic endpoint:
   - Validates the API key
   - Routes to the correct Claude deployment
   - Returns Claude response in standard format

**No middleware, no proxy** - just environment variable redirection. The Claude SDK handles everything naturally.

## Authentication

Azure's managed Anthropic endpoint uses **native Anthropic authentication**:

- ✅ **Works**: `x-api-key: <your-azure-key>`
- ❌ **Does NOT work**: `api-key`, `Ocp-Apim-Subscription-Key`, `Authorization: Bearer`

This is why no proxy or header conversion is needed - Azure accepts the same format the Claude SDK sends natively.

## Model Mapping

Azure deployments use specific model names that may differ from Anthropic's public names:

| Anthropic Model | Azure Deployment | Configuration |
|----------------|------------------|---------------|
| claude-3-5-haiku-latest | claude-sonnet-4-5 | Set `AZURE_MODEL=claude-sonnet-4-5` |
| claude-haiku-4-5-20251001 | claude-sonnet-4-5 | Set `AZURE_MODEL=claude-sonnet-4-5` |
| claude-3-7-sonnet-20250219 | claude-sonnet-4-5 | Set `AZURE_MODEL=claude-sonnet-4-5` |

The `AZURE_MODEL` environment variable forces the correct deployment name for all requests.

## Credential Modes

NanoClaw supports three credential modes:

| Mode | Configuration | Use Case |
|------|--------------|----------|
| **OneCLI** | OneCLI proxy running | Production (most secure) |
| **Direct Azure** | `AZURE_CLAUDE_ENDPOINT` set | Azure cost optimization |
| **Direct Anthropic** | `ANTHROPIC_API_KEY` set (no Azure) | Development/testing |

In **direct-azure** mode:
- Credentials bypass the OneCLI proxy
- API key is injected directly into containers
- Less secure than OneCLI but simpler for Azure deployments

## Configuration Examples

### Switching to Azure

1. Get your Azure API key from Azure Portal
2. Update `.env`:
   ```dotenv
   AZURE_CLAUDE_ENDPOINT=https://<your-resource>.services.ai.azure.com/anthropic
   ANTHROPIC_API_KEY=<your-azure-api-key>
   AZURE_MODEL=claude-sonnet-4-5
   ```
3. Restart the service:
   ```bash
   # macOS
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   
   # Linux
   systemctl --user restart nanoclaw
   ```
4. Verify in logs:
   ```bash
   # Should see: "Preflight: using Azure direct credential mode"
   ```

### Switching Back to Direct Anthropic

1. Update `.env`:
   ```dotenv
   # Comment out or remove Azure config
   # AZURE_CLAUDE_ENDPOINT=...
   ANTHROPIC_API_KEY=<your-anthropic-api-key>
   ```
2. Restart the service

### Using OneCLI Proxy (Most Secure)

1. Start OneCLI gateway: `onecli`
2. Remove both Azure and direct keys from `.env`
3. OneCLI will inject credentials at request time

## Troubleshooting

### 401 Authentication Errors

**Symptom**: "Access denied due to invalid subscription key"

**Causes**:
1. Wrong API key format (using Anthropic key in Azure mode)
2. API key expired or deactivated
3. Azure resource not properly configured

**Fix**: Verify your Azure API key in Azure Portal, ensure it's active and has Anthropic access.

### Wrong Model Errors

**Symptom**: "Model not found" or unexpected model responses

**Cause**: `AZURE_MODEL` not set or misconfigured

**Fix**: Add `AZURE_MODEL=claude-sonnet-4-5` to `.env` and restart.

### Verification

Test Azure endpoint directly:
```bash
curl -X POST https://<your-resource>.services.ai.azure.com/anthropic/v1/messages \
  -H "x-api-key: <your-azure-key>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hi"}],
    "max_tokens": 10
  }'
```

Expected response: Claude message with `"model": "claude-sonnet-4-5-20250929"` (or similar).

## Cost Savings

Azure's Anthropic pricing typically offers cost savings vs direct Anthropic API:

- **Direct Anthropic**: Standard per-token pricing
- **Azure Foundry**: Potentially lower rates depending on Azure agreement

Actual savings depend on:
- Your Azure contract/agreement
- Usage volume
- Selected model/deployment

Check Azure Portal for current pricing: https://azure.microsoft.com/pricing/details/ai-services/

## Security Considerations

**Direct credential mode** (both Azure and Anthropic) is less secure than OneCLI proxy:

| Aspect | OneCLI Proxy | Direct Azure |
|--------|--------------|--------------|
| Container exposure | ❌ Never sees real key | ✅ Key in container env |
| Credential rotation | Easy (restart proxy) | Must restart service |
| Key leak risk | Minimal | Higher |
| Complexity | Higher | Lower |

For maximum security, use OneCLI proxy even with Azure. For simplicity and Azure-specific features, direct mode works well.

## Related Files

- [`src/container-runner.ts`](../src/container-runner.ts) - Environment injection
- [`src/preflight.ts`](../src/preflight.ts) - Credential mode detection
- [`container/agent-runner/src/index.ts`](../container/agent-runner/src/index.ts) - Model forcing
- [`.env.example`](../.env.example) - Environment template
- [`docs/SECURITY.md`](SECURITY.md) - Overall security architecture

## References

- [Azure AI Foundry](https://azure.microsoft.com/products/ai-foundry/)
- [Claude Agent SDK](https://github.com/anthropics/claude-code)
- [Anthropic API Documentation](https://docs.anthropic.com/)
