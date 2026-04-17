# MCP Chatbot — Odoo 18 Addon

A self-contained Odoo 18 addon that adds an AI-powered floating chat bubble to your website. It connects to an external [MCP (Model Context Protocol)] server for tools and uses any OpenAI-compatible LLM for reasoning. Per-user durable facts are stored as plain Odoo records and written by the LLM through a local `remember_fact` tool — no vector database or embedding model required.

## Features

- Floating chat bubble injected into every website page
- Agentic LLM loop with MCP tool calling
- Per-user durable facts stored in `mcp.chatbot.user.fact` and written by the LLM through a local `remember_fact` tool
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

### Python packages

Install into the Odoo virtualenv:

```bash
pip install openai mcp
```

## Installation

1. Copy the `mcp_chatbot` directory into your Odoo `custom_addons` folder.

2. Start your MCP server (must expose a `/mcp` endpoint — e.g. `http://localhost:8010/mcp`).

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
| System Prompt | `mcp_chatbot.system_prompt` | — | Main chatbot system prompt |
| Max Tool Rounds | `mcp_chatbot.max_tool_rounds` | `5` | Agentic loop iteration cap |
| Summary Interval | `mcp_chatbot.summary_interval` | `2000` | Token threshold before summarisation |
| Idle Timeout | `mcp_chatbot.idle_timeout` | `30` | Minutes before idle session closes |
| Summary LLM overrides | `mcp_chatbot.summary_api_key`, `summary_base_url`, `summary_model_id` | — | Falls back to the main LLM settings if blank |

## Architecture

### Request flow

```
Browser widget (chatbot_widget.js)
  → POST /mcp_chatbot/message
  → ChatbotController.receive_message()
      1. Resolve session (partner_id or session_token)
      2. Build conversation history:
           [known user facts] + [identity context] + [rolling summary] + [recent messages]
      3. mcp.client.service.process_message()
           → _async_process_message() on background event loop thread
               → OpenAI chat completion with MCP + local tool schemas
               → agentic loop:
                   * local `remember_fact` → writes one mcp.chatbot.user.fact row
                     via a fresh cursor (committed immediately)
                   * all other tools → forwarded to BaseHTTPMCPClient.session.call_tool()
      4. Persist assistant reply to DB
  ← { reply: "..." }
```

### Memory — how facts are stored and used

- **Writing** — inside the agentic loop, the LLM may call `remember_fact(text, category)` to save a durable fact about the user (preferences, allergies, ecosystem, profession, etc.). This is a local tool, not an MCP tool: it is intercepted before forwarding and written directly to `mcp.chatbot.user.fact` on a dedicated cursor.
- **Reading** — at the start of each message, the controller reads all fact rows for the authenticated partner and injects them verbatim as a single system message. Per-user fact sets are small, so everything is sent — the LLM filters by relevance.
- **Backend** — facts are listed under **MCP Chatbot → User Facts** and on a related tab on the partner form. Staff can edit or delete them directly.
- **Anonymous visitors** — the `remember_fact` tool is a no-op for non-authenticated users; facts are only persisted for partners.

### Key source files

| File | Purpose |
|---|---|
| `models/mcp_client_service.py` | Module-level singletons for MCP client, event loop, and tool schemas. Defines `LOCAL_TOOL_SCHEMAS` (including `remember_fact`) and hosts `_handle_remember_fact`. Entry point for all LLM+tool calls. |
| `models/base_client.py` | Thin wrapper around `mcp.ClientSession` (streamable HTTP transport). |
| `controllers/chatbot_controller.py` | All JSON HTTP endpoints. Injects known facts into the system prompt before each MCP call. |
| `models/chatbot_session.py` | Session model with idle timeout and rolling history summary. |
| `models/chatbot_user_fact.py` | Per-user durable fact model. |
| `models/chatbot_rating.py` | User rating model for conversation quality. |
| `static/src/js/chatbot_widget.js` | Frontend bubble widget with markdown rendering, history restoration, and summarisation logic. |

### Odoo models

| Model | Purpose |
|---|---|
| `mcp.chatbot.session` | One session per conversation; tracks `session_token` (anonymous) or `partner_id` (logged-in), rolling `history_summary`, idle timeout |
| `mcp.chatbot.message` | Individual messages with `role` (user/assistant) |
| `mcp.chatbot.user.fact` | Durable per-user facts written by the `remember_fact` local tool |
| `mcp.llm.provider` | LLM provider records |
| `mcp.llm.model` | LLM model records (name used as model identifier in API calls) |
| `mcp.client.service` | AbstractModel — no DB table; entry point for MCP/LLM calls |

### HTTP endpoints

| Route | Method | Purpose |
|---|---|---|
| `/mcp_chatbot/get_uid` | POST | Returns current user's partner ID (`"0"` for anonymous) |
| `/mcp_chatbot/info` | POST | Returns chatbot metadata + current user identity for the hero greeting |
| `/mcp_chatbot/message` | POST | Main chat endpoint |
| `/mcp_chatbot/history` | POST | Returns full session history for page-reload restoration |
| `/mcp_chatbot/close` | POST | Closes the session |

### Session identity

- **Logged-in users** — session identified by `partner_id`; `session_token` is empty. Facts are stored and injected.
- **OTP-verified anonymous users** — after `verify_email_otp` succeeds, the session gets a linked partner and fact storage/injection activates.
- **Pure anonymous users** — session identified by a UUID-v4 `session_token` generated in the browser and persisted in `localStorage`. No facts are stored.

## Development notes

- The MCP client singleton is **per Odoo worker process**. Multi-worker deployments will create one client connection per worker.
- The summariser write is committed on the main request cursor (`request.env.cr.commit()`) **before** the MCP tool loop begins, preventing a PostgreSQL serialization conflict with the MCP server's JSON-RPC writes (e.g. `verify_email_otp` setting `partner_id` on the session row).
- The `.env` file at the repo root is for local reference only — runtime values must be set via the Odoo Settings UI or `ir.config_parameter`.

## License

LGPL-3
