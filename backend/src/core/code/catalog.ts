import type { EdgeRelation } from '../graph/types.js';

export type AwsService = 'dynamodb' | 's3' | 'sqs' | 'sns' | 'lambda';

export interface SdkOperation {
  service: AwsService;
  /** Canonical IAM operation name, e.g. `GetItem`. IAM action is `${service}:${operation}`. */
  operation: string;
  relation: EdgeRelation;
}

/** The request field that names the target resource for each service. */
export const TARGET_FIELD: Record<AwsService, string> = {
  dynamodb: 'TableName',
  s3: 'Bucket',
  sqs: 'QueueUrl',
  sns: 'TopicArn',
  lambda: 'FunctionName',
};

const op = (service: AwsService, operation: string, relation: EdgeRelation): SdkOperation => ({ service, operation, relation });

// ---- JavaScript / TypeScript (AWS SDK v3 command classes) ----------------------------------------
export const JS_COMMANDS: Record<string, SdkOperation> = {
  // @aws-sdk/client-dynamodb and lib-dynamodb
  GetItemCommand: op('dynamodb', 'GetItem', 'reads'),
  GetCommand: op('dynamodb', 'GetItem', 'reads'),
  BatchGetItemCommand: op('dynamodb', 'BatchGetItem', 'reads'),
  BatchGetCommand: op('dynamodb', 'BatchGetItem', 'reads'),
  QueryCommand: op('dynamodb', 'Query', 'reads'),
  ScanCommand: op('dynamodb', 'Scan', 'reads'),
  PutItemCommand: op('dynamodb', 'PutItem', 'writes'),
  PutCommand: op('dynamodb', 'PutItem', 'writes'),
  UpdateItemCommand: op('dynamodb', 'UpdateItem', 'writes'),
  UpdateCommand: op('dynamodb', 'UpdateItem', 'writes'),
  BatchWriteItemCommand: op('dynamodb', 'BatchWriteItem', 'writes'),
  BatchWriteCommand: op('dynamodb', 'BatchWriteItem', 'writes'),
  DeleteItemCommand: op('dynamodb', 'DeleteItem', 'writes'),
  DeleteCommand: op('dynamodb', 'DeleteItem', 'writes'),
  // @aws-sdk/client-s3
  GetObjectCommand: op('s3', 'GetObject', 'reads'),
  HeadObjectCommand: op('s3', 'GetObject', 'reads'),
  ListObjectsV2Command: op('s3', 'ListBucket', 'reads'),
  ListObjectsCommand: op('s3', 'ListBucket', 'reads'),
  PutObjectCommand: op('s3', 'PutObject', 'writes'),
  CopyObjectCommand: op('s3', 'PutObject', 'writes'),
  DeleteObjectCommand: op('s3', 'DeleteObject', 'writes'),
  // @aws-sdk/client-sqs
  SendMessageCommand: op('sqs', 'SendMessage', 'publishes'),
  SendMessageBatchCommand: op('sqs', 'SendMessage', 'publishes'),
  ReceiveMessageCommand: op('sqs', 'ReceiveMessage', 'reads'),
  DeleteMessageCommand: op('sqs', 'DeleteMessage', 'writes'),
  // @aws-sdk/client-sns, client-lambda
  PublishCommand: op('sns', 'Publish', 'publishes'),
  InvokeCommand: op('lambda', 'InvokeFunction', 'invokes'),
};

// ---- JavaScript SDK v2 / DocumentClient methods ---------------------------------------------------
/** Method names that are unambiguous on their own. */
export const JS_METHODS: Record<string, SdkOperation> = {
  getItem: op('dynamodb', 'GetItem', 'reads'),
  putItem: op('dynamodb', 'PutItem', 'writes'),
  updateItem: op('dynamodb', 'UpdateItem', 'writes'),
  deleteItem: op('dynamodb', 'DeleteItem', 'writes'),
  batchGetItem: op('dynamodb', 'BatchGetItem', 'reads'),
  batchWriteItem: op('dynamodb', 'BatchWriteItem', 'writes'),
  getObject: op('s3', 'GetObject', 'reads'),
  headObject: op('s3', 'GetObject', 'reads'),
  putObject: op('s3', 'PutObject', 'writes'),
  deleteObject: op('s3', 'DeleteObject', 'writes'),
  listObjectsV2: op('s3', 'ListBucket', 'reads'),
  listObjects: op('s3', 'ListBucket', 'reads'),
  upload: op('s3', 'PutObject', 'writes'),
  sendMessage: op('sqs', 'SendMessage', 'publishes'),
  sendMessageBatch: op('sqs', 'SendMessage', 'publishes'),
  receiveMessage: op('sqs', 'ReceiveMessage', 'reads'),
  deleteMessage: op('sqs', 'DeleteMessage', 'writes'),
  publish: op('sns', 'Publish', 'publishes'),
  invoke: op('lambda', 'InvokeFunction', 'invokes'),
};

/** DocumentClient-style method names that collide with unrelated APIs; only counted when the call has `TableName`. */
export const JS_AMBIGUOUS_DYNAMO_METHODS: Record<string, SdkOperation> = {
  get: op('dynamodb', 'GetItem', 'reads'),
  put: op('dynamodb', 'PutItem', 'writes'),
  update: op('dynamodb', 'UpdateItem', 'writes'),
  delete: op('dynamodb', 'DeleteItem', 'writes'),
  query: op('dynamodb', 'Query', 'reads'),
  scan: op('dynamodb', 'Scan', 'reads'),
  batchGet: op('dynamodb', 'BatchGetItem', 'reads'),
  batchWrite: op('dynamodb', 'BatchWriteItem', 'writes'),
};

// ---- Python (boto3) ----------------------------------------------------------------------------------
export const PY_METHODS: Record<string, SdkOperation> = {
  get_item: op('dynamodb', 'GetItem', 'reads'),
  put_item: op('dynamodb', 'PutItem', 'writes'),
  update_item: op('dynamodb', 'UpdateItem', 'writes'),
  delete_item: op('dynamodb', 'DeleteItem', 'writes'),
  batch_get_item: op('dynamodb', 'BatchGetItem', 'reads'),
  batch_write_item: op('dynamodb', 'BatchWriteItem', 'writes'),
  get_object: op('s3', 'GetObject', 'reads'),
  head_object: op('s3', 'GetObject', 'reads'),
  download_file: op('s3', 'GetObject', 'reads'),
  download_fileobj: op('s3', 'GetObject', 'reads'),
  list_objects_v2: op('s3', 'ListBucket', 'reads'),
  list_objects: op('s3', 'ListBucket', 'reads'),
  put_object: op('s3', 'PutObject', 'writes'),
  upload_file: op('s3', 'PutObject', 'writes'),
  upload_fileobj: op('s3', 'PutObject', 'writes'),
  delete_object: op('s3', 'DeleteObject', 'writes'),
  send_message: op('sqs', 'SendMessage', 'publishes'),
  send_message_batch: op('sqs', 'SendMessage', 'publishes'),
  receive_message: op('sqs', 'ReceiveMessage', 'reads'),
  delete_message: op('sqs', 'DeleteMessage', 'writes'),
  publish: op('sns', 'Publish', 'publishes'),
  invoke: op('lambda', 'InvokeFunction', 'invokes'),
};

/** `table.query(...)`/`table.scan(...)` are only DynamoDB when the receiver is a known Table. */
export const PY_TABLE_METHODS: Record<string, SdkOperation> = {
  query: op('dynamodb', 'Query', 'reads'),
  scan: op('dynamodb', 'Scan', 'reads'),
};

export const iamAction = (o: SdkOperation): string => `${o.service}:${o.operation}`;
