import boto3
from botocore.exceptions import ClientError
from app.config import TABLE_NAME
from app.utils import now_iso

dynamodb = boto3.client("dynamodb")

def ensure_table_exists():
    """Create the DynamoDB table if it doesn't exist"""
    try:
        dynamodb.describe_table(TableName=TABLE_NAME)
        print(f"Table {TABLE_NAME} already exists")
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            print(f"Creating table {TABLE_NAME}...")
            dynamodb.create_table(
                TableName=TABLE_NAME,
                KeySchema=[
                    {"AttributeName": "deviceId", "KeyType": "HASH"}
                ],
                AttributeDefinitions=[
                    {"AttributeName": "deviceId", "AttributeType": "S"}
                ],
                BillingMode="PAY_PER_REQUEST"  # or use ProvisionedThroughput
            )
            # Wait for table to be created
            waiter = dynamodb.get_waiter('table_exists')
            waiter.wait(TableName=TABLE_NAME)
            print(f"Table {TABLE_NAME} created successfully")
        else:
            raise

def unmarshal_state(item, device_id):
    return {
        "deviceId": device_id,
        "mode": item["mode"]["S"],
        "rpm": float(item["rpm"]["N"]),
        "rpmTarget": float(item["rpmTarget"]["N"]),
        "waterLevel": float(item["waterLevel"]["N"]),
        "waterTarget": float(item["waterTarget"]["N"]),
        "lastChange": item["lastChange"]["S"],
        "lastSampleAt": item.get("lastSampleAt", {}).get("S", item["lastChange"]["S"]),
    }

def marshal_state(s):
    return {
        "deviceId": {"S": s["deviceId"]},
        "mode": {"S": s["mode"]},
        "rpm": {"N": str(s["rpm"])},
        "rpmTarget": {"N": str(s["rpmTarget"])},
        "waterLevel": {"N": str(s["waterLevel"])},
        "waterTarget": {"N": str(s["waterTarget"])},
        "lastChange": {"S": s["lastChange"]},
        "lastSampleAt": {"S": s["lastSampleAt"]},
    }

def load_state(device_id):
    try:
        res = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={"deviceId": {"S": device_id}}
        )
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            # Table doesn't exist, create it
            ensure_table_exists()
            # Retry the get_item
            res = dynamodb.get_item(
                TableName=TABLE_NAME,
                Key={"deviceId": {"S": device_id}}
            )
        else:
            raise
    
    if "Item" in res:
        return unmarshal_state(res["Item"], device_id)

    # initialize if missing
    now = now_iso()
    init = {
        "deviceId": device_id,
        "mode": "stopped",
        "rpm": 0,
        "rpmTarget": 3000,
        "waterLevel": 35.0,
        "waterTarget": 100,
        "lastChange": now,
        "lastSampleAt": now,
    }
    save_state(init)
    return init

def save_state(s):
    try:
        dynamodb.put_item(TableName=TABLE_NAME, Item=marshal_state(s))
    except ClientError as e:
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            ensure_table_exists()
            dynamodb.put_item(TableName=TABLE_NAME, Item=marshal_state(s))
        else:
            raise