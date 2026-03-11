import json
from pathlib import Path
from datetime import datetime
from contextlib import AsyncExitStack
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


class BaseHTTPMCPClient:
    """
    Base MCP client using Streamable HTTP transport.
    Handles connection lifecycle only.
    """

    def __init__(self, server_url: str):
        self.server_url = server_url          # Store the MCP server URL
        self.session = None                   # Will hold the MCP ClientSession
        self.exit_stack = AsyncExitStack()    # Manages async context cleanup
        self._connected = False               # Internal flag to avoid double connection

    async def connect(self):
        # Prevent connecting twice
        if self._connected:
            return

        # Open a streamable HTTP connection to the MCP server
        streams = await self.exit_stack.enter_async_context(
            streamable_http_client(self.server_url)
        )

        # Unpack the read and write streams (ignore the third returned value)
        read, write, _ = streams

        # Create MCP client session using read/write streams
        self.session = await self.exit_stack.enter_async_context(
            ClientSession(read, write)
        )

        # Perform MCP initialization handshake (capability negotiation)
        await self.session.initialize()

        # Mark client as connected
        self._connected = True

    async def cleanup(self):
        # Close all async contexts (session + HTTP connection) safely
        await self.exit_stack.aclose()
