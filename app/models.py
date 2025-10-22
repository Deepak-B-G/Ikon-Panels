from pydantic import BaseModel

class CommandRequest(BaseModel):
    deviceId: str = "pump-001"
    action: str
