from . import base_client          # BaseHTTPMCPClient (pure Python, no Odoo ORM)
from . import mcp_client_service   # MCPClientService  (Odoo AbstractModel, owns the MCP connection)
from . import chatbot_session      # custom.chatbot.session
from . import chatbot_message      # custom.chatbot.message
from . import chatbot_user_fact    # mcp.chatbot.user.fact
from . import mcp_llm_model
from . import mcp_llm_provider
from . import res_config_settings
