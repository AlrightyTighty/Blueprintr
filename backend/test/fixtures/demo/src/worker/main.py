import json
import os

import boto3

dynamodb = boto3.resource("dynamodb")
sqs = boto3.client("sqs")
table = dynamodb.Table(os.environ["TABLE_NAME"])


def process(record):
    order = json.loads(record["body"])
    table.put_item(Item=order)


def handler(event, context):
    for record in event["Records"]:
        process(record)
    sqs.receive_message(QueueUrl=os.environ["QUEUE_URL"], MaxNumberOfMessages=1)
