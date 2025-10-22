from fastapi import APIRouter, HTTPException
from datetime import datetime, timezone
from app.db import load_state, save_state
from app.simulation import evolve

router = APIRouter(prefix="/telemetry")

@router.get("/")
async def get_telemetry(deviceId: str = "pump-001"):
    try:
        now_dt = datetime.now(timezone.utc)
        s = load_state(deviceId.strip())
        s = evolve(s, now_dt)
        save_state(s)

        return {
            "deviceId": deviceId,
            "ts": now_dt.isoformat(),
            "rpm": s["rpm"],
            "waterLevel": s["waterLevel"],
            "mode": s["mode"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
