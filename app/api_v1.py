from fastapi import APIRouter
from app.routes.telemetry import router as telemetry_router
from app.routes.command import router as command_router

api_v1 = APIRouter(prefix="/api/v1")

api_v1.include_router(telemetry_router)
api_v1.include_router(command_router)
