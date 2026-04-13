# MCP Chatbot — Odoo 18 Addon

A self-contained Odoo 18 addon that adds an AI-powered floating chat bubble to your website. It connects to an external [MCP (Model Context Protocol)] server for tools, uses any OpenAI-compatible LLM for reasoning, and maintains long-term per-user memory via ChromaDB + fastembed.

## Features

- Floating chat bubble injected into every website page
- Agentic LLM loop with MCP tool calling
- Long-term user memory via ChromaDB (RAG — Retrieval-Augmented Generation)
- Automatic fact extraction from conversations
- Rolling conversation summarisation (token-based)
- Session tracking for both logged-in and anonymous users
- Idle session cleanup via cron
- Configurable via Odoo Settings UI (no code changes needed)
- Markdown rendering with tables, links, and headings in the chat widget
- Conversation rating system

## Requirements

### Odoo dependencies

- Odoo 18
- Odoo addons: `base`, `web`, `website`, `auth_signup`, `im_livechat`

### External services

| Service | Default URL | Purpose |
|---|---|---|
| MCP server | `http://localhost:8010/mcp` | Tool execution |
| ChromaDB | `http://localhost:8015` | Vector memory store |

### Python packages

Install into the Odoo virtualenv:

```bash
pip install fastembed chromadb openai mcp
```

## Installation

1. Copy the `mcp_chatbot` directory into your Odoo `custom_addons` folder.

2. Start external services:

```bash
# ChromaDB vector store
chroma run --host 0.0.0.0 --port 8015 --path /opt/chroma_data

# Your MCP server (must expose a /mcp endpoint)
# e.g. http://localhost:8010/mcp
```

3. Install the module:

```bash
python odoo-bin -d <database> -u mcp_chatbot
```

Or install via **Odoo Apps menu** after restarting the server.

## Configuration

Go to **Settings → Technical → MCP Chatbot** to configure the module. All settings are stored as `ir.config_parameter` entries under the `mcp_chatbot.*` namespace.

| Setting | Key | Default | Purpose |
|---|---|---|---|
| MCP Server URL | `mcp_chatbot.mcp_server_url` | — | URL of the MCP tool server |
| LLM API Key | `mcp_chatbot.api_key` | — | API key for the LLM provider |
| LLM Base URL | `mcp_chatbot.base_url` | — | OpenAI-compatible base URL |
| LLM Model | `mcp_chatbot.llm_model_id` | — | FK to `mcp.llm.model` |
| Fact Extraction Model | `mcp_chatbot.fact_extraction_model_id` | — | Model used for RAG fact extraction |
| System Prompt | `mcp_chatbot.system_prompt` | — | Main chatbot system prompt |
| RAG System Prompt | `mcp_chatbot.rag_system_prompt` | — | Prompt for the fact extraction LLM |
| Max Tool Rounds | `mcp_chatbot.max_tool_rounds` | `5` | Agentic loop iteration cap |
| Summary Interval | `mcp_chatbot.summary_interval` | `2000` | Token threshold before summarisation |
| Idle Timeout | `mcp_chatbot.idle_timeout` | `30` | Minutes before idle session closes |

## Architecture

### Request flow

```
Browser widget (chatbot_widget.js)
  → POST /mcp_chatbot/message
  → ChatbotController.receive_message()
      1. Resolve session (partner_id or session_token)
      2. Build conversation history:
           [RAG memories] + [identity context] + [rolling summary] + [recent messages]
      3. mcp.client.service.process_message()
           → _async_process_message() on background event loop thread
               → OpenAI chat completion with MCP tool schemas
               → agentic loop: tool calls → MCP server → results back to LLM
      4. Persist assistant reply to DB
      5. extract_facts_async() — daemon thread — extracts facts,
         writes to ChromaDB + mirrors into mcp.chatbot.user.fact
  ← { reply: "..." }
```

### Key source files

| File | Purpose |
|---|---|
| `models/mcp_client_service.py` | Module-level singletons for MCP client, event loop, and tool schemas. Entry point for all LLM+tool calls. |
| `models/base_client.py` | Thin wrapper around `mcp.ClientSession` (streamable HTTP transport). |
| `controllers/chatbot_controller.py` | All JSON HTTP endpoints. Loads services via `importlib` (services are outside Odoo's package loader). |
| `services/memory_service.py` | ChromaDB client. One collection per user (`user_memory_{partner_id}`). Deduplicates at cosine similarity > 0.92. Prunes to 200 facts max. |
| `services/embedding_service.py` | fastembed singleton using `BAAI/bge-small-en-v1.5` (ONNX, no PyTorch). |
| `services/fact_extractor.py` | Daemon thread that extracts structured facts from each conversation turn and persists them. |
| `models/chatbot_session.py` | Session model with idle timeout and rolling history summary. |
| `models/chatbot_rating.py` | User rating model for conversation quality. |
| `static/src/js/chatbot_widget.js` | Frontend bubble widget with markdown rendering, history restoration, and summarisation logic. |

### Odoo models

| Model | Purpose |
|---|---|
| `mcp.chatbot.session` | One session per conversation; tracks `session_token` (anonymous) or `partner_id` (logged-in), rolling `history_summary`, idle timeout |
| `mcp.chatbot.message` | Individual messages with `role` (user/assistant) |
| `mcp.chatbot.user.fact` | Odoo-side mirror of ChromaDB facts, keyed on `chroma_doc_id` |
| `mcp.llm.provider` | LLM provider records |
| `mcp.llm.model` | LLM model records (name used as model identifier in API calls) |
| `mcp.client.service` | AbstractModel — no DB table; entry point for MCP/LLM calls |

### HTTP endpoints

| Route | Method | Purpose |
|---|---|---|
| `/mcp_chatbot/get_uid` | POST | Returns current user's partner ID (`"0"` for anonymous) |
| `/mcp_chatbot/welcome` | POST | Returns personalised welcome message |
| `/mcp_chatbot/message` | POST | Main chat endpoint |
| `/mcp_chatbot/history` | POST | Returns full session history for page-reload restoration |
| `/mcp_chatbot/close` | POST | Closes the session |

### Session identity

- **Logged-in users** — session identified by `partner_id`; `session_token` is empty. RAG memory and fact extraction are active.
- **Anonymous users** — session identified by a UUID-v4 `session_token` generated in the browser and persisted in `localStorage`. RAG memory and fact extraction are disabled.

## Development notes

- The `services/` directory is **not** an Odoo package — files are loaded manually with `importlib`. Do not add imports for these in `models/__init__.py`.
- The MCP client singleton is **per Odoo worker process**. Multi-worker deployments will create one client connection per worker.
- The `.env` file at the repo root is for local reference only — runtime values must be set via the Odoo Settings UI or `ir.config_parameter`.

## License

LGPL-3
