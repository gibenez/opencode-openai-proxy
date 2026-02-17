# OpenCode AI - Docker Image with OpenAI Compatibility

This Docker image provides a complete and optimized environment to run the [OpenCode AI](https://opencode.ai) server. It includes an integrated Translation Layer (Proxy) that makes OpenCode compatible with any tool that supports the OpenAI API.

## 🌟 Key Features

- **OpenAI Compatibility Proxy:** Use OpenCode as if it were the OpenAI service. Compatible with LibreChat, Dify, TypingMind, etc.
- **Streaming Support:** Real-time responses via Server-Sent Events (SSE).
- **Dynamic Model Mapping:** Automatic support for multiple providers in `provider/model` format.
- **Native API Exposed:** Full access to OpenCode's original features and web interface.
- **Secure by Default:** Authentication via Bearer Token for the Proxy and Basic Auth for the native API.
- **Data Persistence:** Volumes configured to keep sessions, database, and settings.
- **Permission Support (NAS):** Supports `PUID` and `PGID` variables to avoid permission issues on network volumes.

---

## 🚀 Getting Started

### 1. Via Docker Compose (Recommended)

Use the provided [`docker-compose.yml`](./docker-compose.yml) to spin up the service quickly:

1. Define your password in a `.env` file (or directly in the compose file):
   ```env
   OPENCODE_PASSWORD=your_secret_password
   ```

2. Start the container:
   ```bash
   docker-compose up -d
   ```

### 2. Via Docker Run

```bash
docker run -d \
  --name opencode-server \
  -p 4096:4096 \
  -p 4097:4097 \
  -e OPENCODE_SERVER_PASSWORD=your_secret_password \
  -e PUID=1000 \
  -e PGID=1000 \
  -v opencode_data:/home/node/.local/share/opencode \
  -v opencode_config:/home/node/.config/opencode \
  ghcr.io/lucasliet/opencode-openai-proxy:latest
```

---

## 🔌 Connectivity & Ports

| Port | Service | Description | Authentication |
| :--- | :--- | :--- | :--- |
| **4096** | **OpenAI Proxy** | OpenAI SDK/Tools compatible endpoint | `Bearer <YOUR_PASSWORD>` |
| **4097** | **OpenCode Native** | Original API and Web Interface (if available) | `Basic opencode:<YOUR_PASSWORD>` |

---

## 🤖 OpenAI API Usage (Proxy)

The proxy translates OpenAI format calls to the internal OpenCode SDK transparently.

- **Base URL:** `http://localhost:4096/v1`
- **API Key:** Use the password defined in `OPENCODE_SERVER_PASSWORD`.
- **Models:** Use the `provider/model-id` format. Examples: `opencode/gpt-5-nano` (Free), `anthropic/claude-3-5-sonnet`.

### Chat Completion Example (Sync)
```bash
curl http://localhost:4096/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "messages": [{"role": "user", "content": "Hello, who are you?"}]
  }'
```

### Streaming Example (SSE)
Simply add `"stream": true` to the payload and the proxy will send data word by word.

### Responses API Example (Non-Streaming)
```bash
curl http://localhost:4096/v1/responses \
  -H "Authorization: Bearer <YOUR_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "input": "Hello from responses api"
  }'
```

### Responses API Streaming Example (SSE)
```bash
curl -N http://localhost:4096/v1/responses \
  -H "Authorization: Bearer <YOUR_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "input": "Stream a short answer",
    "stream": true
  }'
```

Note: in this phase, `/v1/responses` supports text/multimodal + streaming + `previous_response_id`.
Function/tool calling is implemented in a separate feature branch.

---

## 🧪 Automated Tests

We ensure proxy stability through two test layers located in the `tests/` folder:

1. **Unit Tests:** Validates routing and mapping logic using SDK mocks.
   ```bash
   ./tests/test-unit.sh
   ```
2. **Integration Tests:** Builds the actual Docker image and runs requests against a live OpenCode server.
   ```bash
   ./tests/test-integration.sh
   ```

---

## 🛠️ Development & Build

The image is built on top of `node:lts-slim` to ensure it is lightweight and compatible.

### Local Build
```bash
docker build -t opencode-api .
```

### Internal Orchestration
The container uses [`entrypoint.sh`](./entrypoint.sh) to start the OpenCode server in the background, wait for the health check, and then bring up the Express Proxy in the foreground.
