# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this module does

`mcp_chatbot` is a self-contained Odoo 18 addon that adds an AI-powered floating chat bubble to the website. It connects to an external MCP (Model Context Protocol) server for tools, uses an OpenAI-compatible LLM for reasoning, and maintains long-term user memory via ChromaDB + fastembed.

## Running / installing

Install the module via Odoo's Apps menu or CLI:
```bash
# Restart Odoo with module update
python odoo-bin -d <db> -u mcp_chatbot
```

Start the required external services before running Odoo:
```bash
# MCP server (must expose /mcp endpoint)
# default: http://localhost:8010/mcp

# ChromaDB vector store
chroma run --host 0.0.0.0 --port 8015 --path /opt/chroma_data
```

Install Python dependencies into the Odoo virtualenv:
```bash
pip install fastembed chromadb openai mcp
```

## Configuration (via Odoo Settings → Technical → MCP Chatbot)

All runtime settings are stored in `ir.config_parameter` with the `mcp_chatbot.*` namespace:

| Key | Purpose |
|---|---|
| `mcp_chatbot.mcp_server_url` | MCP server URL |
| `mcp_chatbot.api_key` | LLM API key |
| `mcp_chatbot.base_url` | LLM base URL (OpenAI-compatible) |
| `mcp_chatbot.llm_model_id` | FK to `mcp.llm.model` |
| `mcp_chatbot.fact_extraction_model_id` | FK to `mcp.llm.model` for RAG extraction |
| `mcp_chatbot.system_prompt` | Main chatbot system prompt |
| `mcp_chatbot.rag_system_prompt` | System prompt for fact extraction LLM |
| `mcp_chatbot.max_tool_rounds` | Agentic loop cap (default 5) |
| `mcp_chatbot.summary_interval` | Messages before history summarisation (default 10) |
| `mcp_chatbot.idle_timeout` | Minutes before idle session is closed (default 30) |

## Architecture

### Request flow (one user message)

```
Browser widget (chatbot_widget.js)
  → POST /mcp_chatbot/message
  → ChatbotController.receive_message()
      1. Resolve session (partner_id or session_token)
      2. Build conversation_history:
           [RAG memories] + [identity context] + [rolling summary] + [recent messages]
      3. mcp.client.service.process_message()
           → _async_process_message() in background event loop
               → OpenAI chat completion with MCP tool schemas
               → agentic loop: tool calls → BaseHTTPMCPClient.session.call_tool()
      4. Persist assistant reply
      5. extract_facts_async() — daemon thread — extracts facts, writes to ChromaDB + mcp.chatbot.user.fact
  ← { reply: "..." }
```

### Key files

- **`models/mcp_client_service.py`** — module-level singletons (`_mcp_client`, `_event_loop`, `_tool_schemas`). The MCP client is initialized once per Odoo worker process via `ensure_initialized()`. The async LLM+tool loop runs on a dedicated background thread (`mcp-event-loop`). `AUTH_REQUIRED_TOOLS` lists tools that automatically receive `partner_id`.

- **`models/base_client.py`** — thin wrapper around `mcp.ClientSession` using streamable HTTP transport. Only handles connect/cleanup lifecycle.

- **`controllers/chatbot_controller.py`** — all JSON endpoints. Services (`fact_extractor`, `memory_service`) are loaded via `importlib.util.spec_from_file_location` instead of normal imports because the `services/` directory is outside Odoo's package loader context.

- **`services/memory_service.py`** — ChromaDB HTTP client. One collection per user: `user_memory_{partner_id}`. Deduplicates on cosine similarity > 0.92 (`DEDUP_THRESHOLD`). Prunes oldest when > 200 facts (`MAX_MEMORIES_PER_USER`).

- **`services/embedding_service.py`** — fastembed (ONNX, no PyTorch) with model `BAAI/bge-small-en-v1.5`. Singleton per Odoo worker process.

- **`services/fact_extractor.py`** — daemon thread per message; calls LLM to extract structured facts (JSON with `facts[].text` and `facts[].category`), then writes to ChromaDB via `memory_service` and mirrors into `mcp.chatbot.user.fact` using a fresh DB cursor (the original request cursor is already committed at this point).

### Odoo models

| Model | Purpose |
|---|---|
| `mcp.chatbot.session` | One session per open conversation; tracks `session_token` (anonymous) or `partner_id` (logged-in), rolling `history_summary`, idle timeout |
| `mcp.chatbot.message` | Individual messages with `role` (user/assistant) |
| `mcp.chatbot.user.fact` | Odoo-side mirror of ChromaDB facts, keyed on `chroma_doc_id` |
| `mcp.llm.provider` | LLM provider records |
| `mcp.llm.model` | LLM model records (name used as model identifier in API calls) |
| `mcp.client.service` | AbstractModel — no DB table, entry point for MCP/LLM calls |

### Frontend endpoints

| Route | Purpose |
|---|---|
| `POST /mcp_chatbot/get_uid` | Returns current user's partner ID (or `"0"` for anonymous) |
| `POST /mcp_chatbot/welcome` | Returns personalised welcome message |
| `POST /mcp_chatbot/message` | Main chat endpoint |
| `POST /mcp_chatbot/history` | Returns full session history for page reload restoration |
| `POST /mcp_chatbot/close` | Closes the session |

### Session identity rules

- **Logged-in users**: session identified by `partner_id`; `session_token` is empty.
- **Anonymous users**: session identified by UUID-v4 `session_token` generated in the browser and persisted in `localStorage`.
- RAG memory and fact extraction only run for authenticated users.

## Important implementation notes

- The `services/` directory is **not** an Odoo package — files are loaded manually with `importlib`. Do not add `__init__.py` imports for these in `models/__init__.py`.
- The MCP client singleton is **per Odoo worker process**. Multi-worker deployments will create one connection per worker.
- `action_close()` in `chatbot_session.py` contains a `print()` debug statement (lines 169–171) that should be removed for production.
- The `.env` file at the repo root is for local reference only — actual runtime values must be set via Odoo Settings UI or `ir.config_parameter`.
