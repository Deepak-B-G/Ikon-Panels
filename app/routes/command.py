from fastapi import APIRouter, HTTPException
from datetime import datetime, timezone
from app.models import CommandRequest
from app.db import load_state, save_state
from app.simulation import evolve

router = APIRouter(prefix="/command")

@router.post("")
async def post_command(cmd: CommandRequest):
    try:
        now_dt = datetime.now(timezone.utc)
        s = load_state(cmd.deviceId.strip())
        s = evolve(s, now_dt)

        action = cmd.action.lower()
        if action == "start":
            s["mode"] = "running"
            s["lastChange"] = now_dt.isoformat()
        elif action == "stop":
            s["mode"] = "stopped"
            s["lastChange"] = now_dt.isoformat()
        else:
            raise HTTPException(status_code=400, detail="Invalid action. Use 'start' or 'stop'.")

        save_state(s)
        return {"ok": True, "state": s}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
