import os

TABLE_NAME = os.getenv("TABLE_NAME", "ikon-sim-state")

MAX_RPM = 3000
RAMP_RPM_PER_SEC = 300
FILL_PER_SEC = 0.25
DRAIN_PER_SEC = 0.10
