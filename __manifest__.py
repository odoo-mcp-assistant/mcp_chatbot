{
    'name': 'MCP Chatbot',
    'version': '18.0.1.0.0',
    'summary': 'AI chatbot — website bubble + Odoo-side session storage and settings for the FastAPI sidecar (mcp_chatbot_api)',
    'description': """
        Odoo-side half of the MCP chatbot. The LLM + MCP agentic loop runs
        in the separate mcp_chatbot_api FastAPI service; this addon provides:
        - Chatbot session + message + user-fact models
        - Floating website bubble (injected via website.layout)
        - JWT issuer controller so the widget can call FastAPI directly
        - Settings UI (ir.config_parameter) consumed by the FastAPI service
        - Cron job to close idle sessions
    """,
    'author': 'Custom',
    'category': 'Website',
    'depends': [
        'base',
        'web',
        'website',
        'auth_signup',      # Override _signup_create_user to reuse bare partners
        'im_livechat',      # Needed only for the History Summary menu parent
    ],
    'data': [
        'security/ir.model.access.csv',
        'data/cron.xml',
        'views/chatbot_session_views.xml',
        'views/chatbot_message_views.xml',
        'views/chatbot_user_fact_views.xml',
        'views/chatbot_usage_views.xml',
        'views/snippet_template.xml',
        'views/configuration_views.xml',
        'views/res_partner_views.xml',
        'views/res_partner_inherit_views.xml',
        'views/chatbot_rating_views.xml',
        'views/res_config_settings_views.xml',
    ],
    'assets': {
        'web.assets_frontend': [
            'mcp_chatbot/static/src/css/chatbot_widget.css',
            'mcp_chatbot/static/src/js/chatbot_api.js',
            'mcp_chatbot/static/src/js/chatbot_render.js',
            'mcp_chatbot/static/src/js/chatbot_widget.js',
        ],
    },
    'external_dependencies': {
        'python': ['jose'],
    },
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
}
