# mcp_chatbot — Odoo AI Chatbot with MCP & RAG Memory

An Odoo module that embeds a fully-featured AI chatbot into your ERP, powered by the **Model Context Protocol (MCP)** for tool access and **Retrieval-Augmented Generation (RAG)** for long-term user memory.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
  - [RAG Pipeline — Retrieval](#rag-pipeline--retrieval)
  - [RAG Pipeline — Extraction](#rag-pipeline--extraction)
  - [Conversation Memory](#conversation-memory)
  - [MCP Tool Calls](#mcp-tool-calls)
- [Project Structure](#project-structure)
- [API Endpoints](#api-endpoints)
- [Parameters Reference](#parameters-reference)
- [Security](#security)
- [Limitations & Known Issues](#limitations--known-issues)

---

## Overview

`mcp_chatbot` gives your Odoo instance a conversational AI assistant that can:

- Answer questions about your ERP data (products, orders, invoices, stock, etc.) by calling Odoo tools via MCP
- Remember user preferences and context **across sessions** using a vector memory store (ChromaDB)
- Maintain coherent long conversations through automatic history summarization
- Identify and silently inject user identity into tool calls without exposing internal IDs

The assistant is accessible via a JSON HTTP API, making it easy to embed in any Odoo website, portal, or custom frontend.

---

## Architecture

```
Browser / Frontend
        │  POST /mcp_chatbot/message
        ▼
Odoo Controller (chatbot_controller.py)
        │
        ├── RAG Retrieval ──────────────────► ChromaDB (port 8015)
        │   fastembed embed → cosine search      ◄── top-5 facts
        │
        ├── Context Builder
        │   [memories] + [identity] + [summary] + [history] + [message]
        │
        ├── MCP Client Service (mcp_client_service.py)
        │   asyncio event loop (background thread)
        │       │
        │       ├── ListTools ──────────────► MCP Server (port 8010)
        │       ├── LLM Call ───────────────► Groq API (llama-3.3-70b)
        │       └── CallTool ───────────────► MCP Server ──► Odoo ORM
        │
        └── RAG Extraction (async daemon thread)
            fact_extractor.py → LLM (temp=0) → ChromaDB
```

---

## Features

| Feature | Description |
|---|---|
| **MCP Tool Integration** | LLM can call any Odoo tool registered on the MCP server (read products, create orders, check stock, etc.) |
| **Long-Term Memory** | User facts and preferences are extracted and stored in ChromaDB per user, retrieved on every message |
| **Short-Term Memory** | Full conversation history with automatic LLM-based summarization every 10 messages |
| **Identity Injection** | Authenticated users have their name and partner_id silently injected into every tool call |
| **Async Fact Extraction** | Memory learning happens in a background thread — zero latency impact on responses |
| **Deduplication** | Near-duplicate facts (cosine similarity ≥ 0.92) are updated rather than duplicated |
| **Session Management** | Token-based sessions with mismatch protection, inactivity tracking, and clean close |
| **Anonymous Support** | Works for unauthenticated visitors with graceful degradation (no memory, no personal data) |
| **GDPR Ready** | `delete_all_memories(user_id)` drops an entire user's ChromaDB collection on demand |

---

## Requirements

### Python packages (install in your Odoo virtualenv)

```bash
pip install openai fastembed chromadb mcp
```

| Package | Version | Purpose |
|---|---|---|
| `openai` | latest | Groq-compatible LLM client |
| `fastembed` | latest | Local ONNX embeddings (no PyTorch) |
| `chromadb` | latest | Vector database HTTP client |
| `mcp` | latest | Model Context Protocol SDK |

> `fastembed` automatically installs `onnxruntime` as a dependency. On first run it downloads the `BAAI/bge-small-en-v1.5` model (~130 MB) into `~/.cache/fastembed/` and caches it permanently.

If you are installing into the system Python rather than a venv:

```bash
pip install openai fastembed chromadb mcp --break-system-packages
```

### External services

| Service | Default Port | Purpose |
|---|---|---|
| **ChromaDB HTTP server** | `8015` | Vector memory store |
| **MCP Server** | `8010` | Odoo tool server |
| **Groq API** | external | LLM inference |

### Start ChromaDB

```bash
chroma run --host 0.0.0.0 --port 8015 --path /opt/chroma_data
```

---

## Installation

1. Clone or copy this module into your Odoo addons directory:

```bash
cp -r mcp_chatbot /path/to/odoo/addons/
```

2. Install Python dependencies in your Odoo venv:

```bash
source /path/to/odoo/venv/bin/activate
pip install openai fastembed chromadb mcp
```

3. Start ChromaDB as a persistent service:

```bash
chroma run --host 0.0.0.0 --port 8015 --path /opt/chroma_data
```

4. Start your MCP server (the Odoo tool server) on port 8010.

5. Update the Odoo app list and install `mcp_chatbot` from the Apps menu.

---

## Configuration

All configuration is done via environment variables. Set them before starting Odoo:

```bash
export MCP_SERVER_URL="http://localhost:8010/mcp"
export OPENAI_API_KEY="gsk_your_groq_api_key_here"
export OPENAI_MODEL="llama-3.3-70b-versatile"
```

| Variable | Default | Description |
|---|---|---|
| `MCP_SERVER_URL` | `http://localhost:8010/mcp` | URL of the MCP tool server |
| `OPENAI_API_KEY` | — | Groq API key (required) |
| `OPENAI_MODEL` | `llama-3.3-70b-versatile` | LLM model name |

> ChromaDB host and port are currently hardcoded in `memory_service.py` as `localhost:8015`. Edit those constants directly if your setup differs.

---

## How It Works

### RAG Pipeline — Retrieval

Executed **synchronously on every message**, before the LLM is called:

1. The user's message is embedded into a 384-dimensional vector using `fastembed` (model: `BAAI/bge-small-en-v1.5`, runs locally via ONNX).
2. ChromaDB performs a cosine similarity search against the user's personal collection (`user_memory_{partner_id}`).
3. Results with similarity ≥ `0.30` are kept (up to 5 facts).
4. The retrieved facts are injected as the **first system block** in the LLM context, giving them maximum attention priority.

The full context sent to the LLM is a stack (in order):

```
[1] Long-term memories from ChromaDB      ← highest priority
[2] Current user identity (name, partner_id)
[3] Conversation summary (past sessions)
[4] Last N unsummarized messages
[5] Current user message
```

### RAG Pipeline — Extraction

Executed **asynchronously after every message**, in a background daemon thread. The user already has their response before this starts:

1. The current exchange (user message + bot reply — not the full history) is sent to the LLM with `temperature=0` and a strict JSON-only extraction prompt.
2. The LLM returns a JSON array of durable facts (e.g. `{"text": "User prefers responses in French", "category": "language"}`).
3. Each fact is embedded and checked against ChromaDB for near-duplicates (threshold: `0.92`). Near-duplicates are updated; new facts are added.
4. If the collection exceeds 200 facts, the oldest entries are pruned first.

**Fact categories:** `language`, `role`, `odoo_config`, `formatting`, `explicit`, `topic`

**What is NOT extracted:** transient requests, ERP data (prices, quantities, dates), anything session-specific.

### Conversation Memory

Short-term memory uses a rolling window with automatic summarization:

- All messages in a session are stored in Odoo (`mcp.chatbot.message`).
- When 10 or more messages have accumulated since the last summary, the LLM produces a compact summary of that block.
- The summary replaces those messages in the context, keeping token usage bounded regardless of conversation length.
- The `last_summarized_count` field on the session tracks the summarization boundary.

### MCP Tool Calls

The `MCPClientService` runs a persistent asyncio event loop in a background thread (one per Odoo worker process). On first call:

1. It connects to the MCP server and calls `ListTools` to fetch all available tool schemas.
2. Tool schemas are passed to the LLM on every call with `tool_choice="auto"`.
3. If the LLM decides to use a tool, `CallTool` is sent to the MCP server, which executes the corresponding Odoo operation and returns the result.
4. The tool result is appended to the conversation and the LLM produces a final response.

---

## Project Structure

```
mcp_chatbot/
├── __manifest__.py
├── controllers/
│   └── chatbot_controller.py    # HTTP routes, pipeline orchestration
├── models/
│   ├── mcp_client_service.py    # Odoo AbstractModel, asyncio MCP host
│   ├── mcp_chatbot_session.py   # Session model (token, history, summary)
│   └── mcp_chatbot_message.py   # Message model (role, content)
├── services/
│   ├── base_client.py           # BaseHTTPMCPClient (MCP SDK wrapper)
│   ├── embedding_service.py     # fastembed singleton, embed_text()
│   ├── memory_service.py        # ChromaDB read/write, deduplication
│   └── fact_extractor.py        # Async LLM-based fact extraction
└── static/
    └── ...                      # Frontend assets (widget JS/CSS)
```

---

## API Endpoints

All endpoints accept and return JSON (`type='json'`), are public (`auth='public'`), and require no CSRF token.

### `POST /mcp_chatbot/message`

Send a user message and receive the AI reply.

**Request:**
```json
{
  "session_token": "abc123",
  "message": "What are my open purchase orders?",
  "welcome": "Hello! How can I help you today?"
}
```

**Response:**
```json
{
  "reply": "You have 3 open purchase orders...",
  "session_token": "abc123"
}
```

| Field | Required | Description |
|---|---|---|
| `session_token` | yes | Unique session identifier |
| `message` | yes | User message text |
| `welcome` | no | Welcome message to persist as first assistant message (only on first call) |

---

### `POST /mcp_chatbot/welcome`

Generate a personalized welcome message for the current user.

**Request:**
```json
{ "session_token": "abc123" }
```

**Response:**
```json
{ "welcome": "Hello Ahmed! I'm your Odoo AI assistant. How can I help you today?" }
```

---

### `POST /mcp_chatbot/history`

Retrieve the full message history for a session.

**Response:**
```json
{
  "status": "open",
  "messages": [
    { "role": "assistant", "content": "Hello! How can I help?" },
    { "role": "user", "content": "Show me my invoices" },
    { "role": "assistant", "content": "Here are your invoices..." }
  ]
}
```

`status` values: `open`, `closed`, `not_found`, `mismatch`

---

### `POST /mcp_chatbot/close`

Close a session explicitly.

**Request:**
```json
{ "session_token": "abc123" }
```

**Response:**
```json
{ "status": "closed" }
```

---

## Parameters Reference

| Parameter | Location | Value | Description |
|---|---|---|---|
| `MIN_RETRIEVAL_SIMILARITY` | `memory_service.py` | `0.30` | Minimum similarity to include a fact in context |
| `DEDUP_THRESHOLD` | `memory_service.py` | `0.92` | Similarity above which a new fact updates an existing one |
| `MAX_MEMORIES_PER_USER` | `memory_service.py` | `200` | Maximum facts stored per user before pruning oldest |
| `n_results` | `memory_service.py` | `5` | Number of facts retrieved per query |
| `unsummarized_count >= 10` | `chatbot_controller.py` | `10` | Messages accumulated before summarization triggers |
| `EXTRACTION_MODEL` | `fact_extractor.py` | `llama-3.3-70b-versatile` | Model used for fact extraction |
| `temperature` (extraction) | `fact_extractor.py` | `0.0` | Temperature for fact extraction (deterministic) |
| `temperature` (chat) | `mcp_client_service.py` | `0.7` | Temperature for chat responses |
| `timeout` | `mcp_client_service.py` | `60s` | Timeout for async MCP calls |

---

## Security

- **Session isolation:** Each session token is bound to a `partner_id`. Requests with a mismatched token are rejected with `session_mismatch`.
- **Memory isolation:** Each user has a separate ChromaDB collection (`user_memory_{partner_id}`). Cross-user access is architecturally impossible.
- **Anonymous users:** The RAG pipeline (both retrieval and extraction) is disabled for unauthenticated visitors. The chatbot still works but has no memory.
- **Identity injection:** The user's name and `partner_id` are injected silently into the system prompt. The LLM is instructed never to expose raw technical IDs to the user.
- **Tool discipline:** The system prompt strictly forbids the LLM from using a tool for any purpose other than its stated function, and from fabricating results when a tool is unavailable.
- **GDPR:** Call `memory_service.delete_all_memories(user_id)` to permanently drop all stored facts for a user.

---

## Limitations & Known Issues

- **Multi-worker race condition:** In Gunicorn/Uvicorn multi-worker deployments, two workers processing simultaneous messages from the same user may both attempt to add the same fact to ChromaDB before deduplication can detect the conflict. This is rare in practice since conversations are sequential.
- **Anonymous memory loss:** A user who chats anonymously and then logs in starts with an empty memory. There is no mechanism to migrate anonymous session memory to an authenticated account.
- **ChromaDB host hardcoded:** `CHROMA_HOST` and `CHROMA_PORT` in `memory_service.py` are constants, not environment variables. Edit them directly or submit a PR to make them configurable.
- **API key in source:** The Groq API key is currently hardcoded in multiple files as a fallback. Move it to an environment variable (`OPENAI_API_KEY`) for any production deployment.
- **No streaming:** The HTTP API returns a complete response in one JSON payload. Streaming (SSE/WebSocket) is not currently supported.
- **English-only extraction prompt:** The fact extractor's system prompt is in English. The LLM will still extract facts from conversations in other languages, but the extraction quality may vary.
