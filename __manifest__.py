{
    'name': 'MCP Chatbot',
    'version': '18.0.1.0.0',
    'summary': 'Standalone AI chatbot powered by MCP — website bubble, session tracking, LLM pipeline',
    'description': """
        Self-contained chatbot module. No external addon dependency.
        Includes:
        - BaseHTTPMCPClient       (from odoo_mcp_addon/models/base_client.py)
        - MCPClientService        (from odoo_mcp_addon/models/mcp_client_service.py)
        - Chatbot session + message models
        - Floating website bubble (injected via website.layout)
        - JSON controller for frontend ↔ backend communication
        - Cron job to close idle sessions after 30 minutes
    """,
    'author': 'Custom',
    'category': 'Website',
    'depends': [
        'base',
        'web',
        'website',
        'im_livechat',      # Needed only for the History Summary menu parent
    ],
    'data': [
        'security/ir.model.access.csv',
        'data/cron.xml',
        'views/chatbot_session_views.xml',
        'views/chatbot_message_views.xml',
        'views/snippet_template.xml',
    ],
    'assets': {
        'web.assets_frontend': [
            'mcp_chatbot/static/src/css/chatbot_widget.css',
            'mcp_chatbot/static/src/js/chatbot_widget.js',
        ],
    },
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
}
