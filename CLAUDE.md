# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this module does

`mcp_chatbot` is a self-contained Odoo 18 addon that adds an AI-powered floating chat bubble to the website. It connects to an external MCP (Model Context Protocol) server for tools, uses an OpenAI-compatible LLM for reasoning, and keeps durable per-user facts in the Odoo model `mcp.chatbot.user.fact`.

## Running / installing

Install the module via Odoo's Apps menu or CLI:
```bash
# Restart Odoo with module update
python odoo-bin -d <db> -u mcp_chatbot
```

Start the external MCP server before running Odoo:
```bash
# MCP server (must expose /mcp endpoint)
# default: http://localhost:8010/mcp
```

Install Python dependencies into the Odoo virtualenv:
```bash
pip install openai mcp
```

## Configuration (via Odoo Settings → Technical → MCP Chatbot)

All runtime settings are stored in `ir.config_parameter` with the `mcp_chatbot.*` namespace:

| Key | Purpose |
|---|---|
| `mcp_chatbot.mcp_server_url` | MCP server URL |
| `mcp_chatbot.api_key` | LLM API key |
| `mcp_chatbot.base_url` | LLM base URL (OpenAI-compatible) |
| `mcp_chatbot.llm_model_id` | FK to `mcp.llm.model` |
| `mcp_chatbot.system_prompt` | Main chatbot system prompt |
| `mcp_chatbot.max_tool_rounds` | Agentic loop cap (default 5) |
| `mcp_chatbot.summary_interval` | Estimated token threshold before history summarisation (default 2000) |
| `mcp_chatbot.idle_timeout` | Minutes before idle session is closed (default 30) |
| `mcp_chatbot.summary_api_key` / `summary_base_url` / `summary_model_id` | Overrides for the summariser LLM (fall back to the main LLM settings if blank) |

## Architecture

### Request flow (one user message)

```
Browser widget (chatbot_widget.js)
  → POST /mcp_chatbot/message
  → ChatbotController.receive_message()
      1. Resolve session (partner_id or session_token)
      2. Build conversation_history:
           [known user facts] + [identity context] + [rolling summary] + [recent messages]
      3. mcp.client.service.process_message()
           → _async_process_message() in background event loop
               → OpenAI chat completion with MCP + local tool schemas
               → agentic loop:
                   * local `remember_fact` → writes mcp.chatbot.user.fact row (fresh cursor)
                   * every other tool → forwarded to BaseHTTPMCPClient.session.call_tool()
      4. Persist assistant reply
  ← { reply: "..." }
```

### Memory model (no RAG)

User facts are stored in the Odoo model `mcp.chatbot.user.fact` (one row per fact, linked to `res.partner`). There is no vector database, no embedding model, and no background extractor thread.

- **Write path** — the LLM calls the local `remember_fact(text, category)` tool when it decides a statement is durable (preferences, ecosystem, dislikes, allergies, profession, etc.). The tool is intercepted in `_async_process_message` and handled by `_handle_remember_fact` in `mcp_client_service.py`, which opens its own cursor via `registry.cursor()` and commits immediately — independent of the request transaction.
- **Read path** — `receive_message` reads all `mcp.chatbot.user.fact` rows for the authenticated partner and injects them into the conversation as a single system message. Per-user fact sets are small, so all are sent whole; the LLM filters by relevance.
- Facts are editable/deletable in the Odoo backend under the User Facts menu and on the related tab on the partner form.

### Key files

- **`models/mcp_client_service.py`** — module-level singletons (`_mcp_client`, `_event_loop`, `_tool_schemas`). The MCP client is initialized once per Odoo worker process via `ensure_initialized()`. The async LLM+tool loop runs on a dedicated background thread (`mcp-event-loop`). `AUTH_REQUIRED_TOOLS` lists tools that automatically receive `partner_id`. `LOCAL_TOOL_SCHEMAS` defines tools handled inside the addon (currently just `remember_fact`).

- **`models/base_client.py`** — thin wrapper around `mcp.ClientSession` using streamable HTTP transport. Only handles connect/cleanup lifecycle.

- **`controllers/chatbot_controller.py`** — all JSON endpoints. Injects known facts into the system prompt before each MCP call.

- **`services/`** — reserved for future non-ORM helpers. The old ChromaDB / fastembed / fact_extractor layer has been removed.

### Odoo models

| Model | Purpose |
|---|---|
| `mcp.chatbot.session` | One session per open conversation; tracks `session_token` (anonymous) or `partner_id` (logged-in), rolling `history_summary`, idle timeout |
| `mcp.chatbot.message` | Individual messages with `role` (user/assistant) |
| `mcp.chatbot.user.fact` | Durable per-user facts written by the `remember_fact` local tool |
| `mcp.llm.provider` | LLM provider records |
| `mcp.llm.model` | LLM model records (name used as model identifier in API calls) |
| `mcp.client.service` | AbstractModel — no DB table, entry point for MCP/LLM calls |

### Frontend endpoints

| Route | Purpose |
|---|---|
| `POST /mcp_chatbot/get_uid` | Returns current user's partner ID (or `"0"` for anonymous) |
| `POST /mcp_chatbot/info` | Returns chatbot metadata + current user identity for the hero greeting |
| `POST /mcp_chatbot/message` | Main chat endpoint |
| `POST /mcp_chatbot/history` | Returns full session history for page reload restoration |
| `POST /mcp_chatbot/close` | Closes the session |

### Session identity rules

- **Logged-in users**: session identified by `partner_id`; `session_token` is empty.
- **Anonymous users**: session identified by UUID-v4 `session_token` generated in the browser and persisted in `localStorage`.
- Fact storage and injection only apply to authenticated or OTP-verified users — pure anonymous sessions have no stored facts and the `remember_fact` tool returns a no-op error if called for them.

## Important implementation notes

- The MCP client singleton is **per Odoo worker process**. Multi-worker deployments will create one connection per worker.
- `action_close()` in `chatbot_session.py` contains a `print()` debug statement that should be removed for production.
- The summariser write is committed on the main request cursor via `request.env.cr.commit()` **before** the MCP tool loop begins — otherwise the MCP server's JSON-RPC callbacks (e.g. `verify_email_otp` writing `partner_id`) race the open transaction and trigger a serialization conflict, which Odoo then retries (duplicating tool calls).
- `_handle_remember_fact` opens a fresh cursor via `registry.cursor()` for each fact write, so fact persistence is independent of request success/failure.
- The `.env` file at the repo root is for local reference only — actual runtime values must be set via Odoo Settings UI or `ir.config_parameter`.
