from datetime import datetime
from app.utils import clamp
from app.config import RAMP_RPM_PER_SEC, FILL_PER_SEC, DRAIN_PER_SEC, MAX_RPM

def evolve(prev, now_dt: datetime):
    last_dt = datetime.fromisoformat(prev["lastSampleAt"].replace("Z", "+00:00"))
    elapsed = max(0, (now_dt - last_dt).total_seconds())

    target = prev["rpmTarget"] if prev["mode"] == "running" else 0
    rpm = prev["rpm"]

    if rpm < target:
        rpm = min(target, rpm + RAMP_RPM_PER_SEC * elapsed)
    elif rpm > target:
        rpm = max(target, rpm - RAMP_RPM_PER_SEC * elapsed)

    water = prev["waterLevel"]
    if prev["mode"] == "running":
        water = clamp(water + FILL_PER_SEC * elapsed, 0, 100)
    else:
        water = clamp(water - DRAIN_PER_SEC * elapsed, 0, 100)

    return {
        **prev,
        "rpm": round(rpm),
        "waterLevel": round(water, 1),
        "lastSampleAt": now_dt.isoformat(),
    }
