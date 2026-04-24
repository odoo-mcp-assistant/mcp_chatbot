import logging

import requests

from odoo import api, fields, models

from ..services import env_config

_logger = logging.getLogger(__name__)


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    # ------------------------------------------------------------------ #
    # General                                                              #
    # ------------------------------------------------------------------ #

    chatbot_bot_name = fields.Char(
        string="Chatbot Name",
        config_parameter='mcp_chatbot.bot_name',
    )

    chatbot_status = fields.Selection(
        selection=[('online', 'Online'), ('offline', 'Offline')],
        string="Status",
        config_parameter='mcp_chatbot.status',
        default='online',
        required=True,
    )

    # ------------------------------------------------------------------ #
    # LLM Configuration                                                    #
    # ------------------------------------------------------------------ #

    chatbot_api_key = fields.Char(
        string="API Key",
        config_parameter='mcp_chatbot.api_key',
    )

    chatbot_base_url = fields.Char(
        string="Base URL",
        config_parameter='mcp_chatbot.base_url',
    )

    chatbot_llm_provider_id = fields.Many2one(
        comodel_name='mcp.llm.provider',
        string="LLM Provider",
    )

    chatbot_llm_model_id = fields.Many2one(
        string="LLM Model",
        comodel_name='mcp.llm.model',
    )

    chatbot_max_tool_rounds = fields.Integer(
        string="Max Tool Rounds",
        config_parameter='mcp_chatbot.max_tool_rounds',
        default=5,
    )

    chatbot_system_prompt = fields.Char(
        string="System Prompt",
        config_parameter='mcp_chatbot.system_prompt',
    )

    # ------------------------------------------------------------------ #
    # Summary                                                              #
    # ------------------------------------------------------------------ #

    chatbot_summary_provider_id = fields.Many2one(
        comodel_name='mcp.llm.provider',
        string="Summary Provider",
    )

    chatbot_summary_model_id = fields.Many2one(
        comodel_name='mcp.llm.model',
        string="Summary Model",
    )

    chatbot_summary_api_key = fields.Char(
        string="Summary API Key",
        config_parameter='mcp_chatbot.summary_api_key',
    )

    chatbot_summary_base_url = fields.Char(
        string="Summary Base URL",
        config_parameter='mcp_chatbot.summary_base_url',
    )

    # ------------------------------------------------------------------ #
    # Fact Extraction                                                      #
    # ------------------------------------------------------------------ #

    chatbot_fact_provider_id = fields.Many2one(
        comodel_name='mcp.llm.provider',
        string="Fact Extraction Provider",
    )

    chatbot_fact_model_id = fields.Many2one(
        comodel_name='mcp.llm.model',
        string="Fact Extraction Model",
    )

    chatbot_fact_api_key = fields.Char(
        string="Fact Extraction API Key",
        config_parameter='mcp_chatbot.fact_api_key',
    )

    chatbot_fact_base_url = fields.Char(
        string="Fact Extraction Base URL",
        config_parameter='mcp_chatbot.fact_base_url',
    )

    # ------------------------------------------------------------------ #
    # MCP Server                                                           #
    # ------------------------------------------------------------------ #

    chatbot_mcp_server_url = fields.Char(
        string="MCP Server URL",
        config_parameter='mcp_chatbot.mcp_server_url',
    )

    # ------------------------------------------------------------------ #
    # Session Management                                                   #
    # ------------------------------------------------------------------ #

    chatbot_idle_timeout = fields.Integer(
        string="Idle Timeout (minutes)",
        config_parameter='mcp_chatbot.idle_timeout',
        default=30,
    )

    chatbot_summary_interval = fields.Integer(
        string="Summary Token Threshold",
        config_parameter='mcp_chatbot.summary_interval',
        default=2000,
    )

    # ------------------------------------------------------------------ #
    # Onchange: clear model when provider changes                         #
    # ------------------------------------------------------------------ #

    @api.onchange('chatbot_llm_provider_id')
    def _onchange_llm_provider(self):
        if (self.chatbot_llm_model_id
                and self.chatbot_llm_provider_id
                and self.chatbot_llm_model_id.provider_id != self.chatbot_llm_provider_id):
            self.chatbot_llm_model_id = False

    @api.onchange('chatbot_summary_provider_id')
    def _onchange_summary_provider(self):
        if (self.chatbot_summary_model_id
                and self.chatbot_summary_provider_id
                and self.chatbot_summary_model_id.provider_id != self.chatbot_summary_provider_id):
            self.chatbot_summary_model_id = False

    @api.onchange('chatbot_fact_provider_id')
    def _onchange_fact_provider(self):
        if (self.chatbot_fact_model_id
                and self.chatbot_fact_provider_id
                and self.chatbot_fact_model_id.provider_id != self.chatbot_fact_provider_id):
            self.chatbot_fact_model_id = False

    # ------------------------------------------------------------------ #
    # get_values / set_values for Many2one fields                         #
    # ------------------------------------------------------------------ #

    def get_values(self):
        res = super().get_values()
        param = self.env['ir.config_parameter'].sudo()
        LlmModel = self.env['mcp.llm.model']
        LlmProvider = self.env['mcp.llm.provider']

        # LLM provider
        llm_provider_id = param.get_param('mcp_chatbot.llm_provider_id')
        if llm_provider_id and LlmProvider.browse(int(llm_provider_id)).exists():
            res['chatbot_llm_provider_id'] = int(llm_provider_id)
        else:
            res['chatbot_llm_provider_id'] = False

        # LLM model
        llm_model_id = param.get_param('mcp_chatbot.llm_model_id')
        if llm_model_id and LlmModel.browse(int(llm_model_id)).exists():
            res['chatbot_llm_model_id'] = int(llm_model_id)
        else:
            res['chatbot_llm_model_id'] = False

        # Summary provider
        summary_provider_id = param.get_param('mcp_chatbot.summary_provider_id')
        if summary_provider_id and LlmProvider.browse(int(summary_provider_id)).exists():
            res['chatbot_summary_provider_id'] = int(summary_provider_id)
        else:
            res['chatbot_summary_provider_id'] = False

        # Summary model
        summary_model_id = param.get_param('mcp_chatbot.summary_model_id')
        if summary_model_id and LlmModel.browse(int(summary_model_id)).exists():
            res['chatbot_summary_model_id'] = int(summary_model_id)
        else:
            res['chatbot_summary_model_id'] = False

        # Fact extraction provider
        fact_provider_id = param.get_param('mcp_chatbot.fact_provider_id')
        if fact_provider_id and LlmProvider.browse(int(fact_provider_id)).exists():
            res['chatbot_fact_provider_id'] = int(fact_provider_id)
        else:
            res['chatbot_fact_provider_id'] = False

        # Fact extraction model
        fact_model_id = param.get_param('mcp_chatbot.fact_model_id')
        if fact_model_id and LlmModel.browse(int(fact_model_id)).exists():
            res['chatbot_fact_model_id'] = int(fact_model_id)
        else:
            res['chatbot_fact_model_id'] = False

        return res

    def set_values(self):
        super().set_values()
        param = self.env['ir.config_parameter'].sudo()
        param.set_param(
            'mcp_chatbot.llm_provider_id',
            self.chatbot_llm_provider_id.id or False,
        )
        param.set_param(
            'mcp_chatbot.llm_model_id',
            self.chatbot_llm_model_id.id or False,
        )
        param.set_param(
            'mcp_chatbot.summary_provider_id',
            self.chatbot_summary_provider_id.id or False,
        )
        param.set_param(
            'mcp_chatbot.summary_model_id',
            self.chatbot_summary_model_id.id or False,
        )
        param.set_param(
            'mcp_chatbot.fact_provider_id',
            self.chatbot_fact_provider_id.id or False,
        )
        param.set_param(
            'mcp_chatbot.fact_model_id',
            self.chatbot_fact_model_id.id or False,
        )

        # notify FastAPI to reload its config snapshot
        fast_api_base_url = env_config.get('FAST_API_BASE_URL', '')
        if fast_api_base_url:
            try:
                requests.post(f"{fast_api_base_url}/reload_config", timeout=5)
                _logger.info("set_values: FastAPI config reloaded at %s", fast_api_base_url)
            except Exception as exc:
                _logger.warning("set_values: failed to reload FastAPI config: %s", exc)