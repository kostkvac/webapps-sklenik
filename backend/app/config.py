"""Sklenik App Configuration"""
import sys
from pydantic import Field
from pydantic_settings import BaseSettings

sys.path.insert(0, "/opt/webapps")
from shared.config.settings import Settings as SharedSettings


class SklenikSettings(SharedSettings):
    DB_NAME: str = Field(default="sklenik", env="DB_NAME")

    SSH_HOST: str = Field(default="192.168.0.122", env="SSH_HOST")
    SSH_PORT: int = Field(default=22, env="SSH_PORT")
    SSH_USER: str = Field(default="root", env="SSH_USER")
    SSH_KEY_PATH: str = Field(default="/root/.ssh/id_rsa", env="SSH_KEY_PATH")
    SSH_TIMEOUT: int = Field(default=10, env="SSH_TIMEOUT")

    LOGS_DIR: str = Field(default="/opt/webapps/sklenik/data/logs", env="LOGS_DIR")

    # Weather proxy – sdílíme cache s trávník backendem
    WEATHER_PROXY_URL: str = Field(
        default="http://127.0.0.1:8006/api/weather",
        env="WEATHER_PROXY_URL",
    )
    WEATHER_CACHE_MINUTES: int = Field(default=60, env="WEATHER_CACHE_MINUTES")

    class Config:
        env_file = "/opt/webapps/sklenik/.env"
        case_sensitive = True
        extra = "ignore"


sklenik_settings = SklenikSettings()
