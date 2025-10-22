import logging
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ikon-sim")

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

def now_iso():
    return datetime.now(timezone.utc).isoformat()
