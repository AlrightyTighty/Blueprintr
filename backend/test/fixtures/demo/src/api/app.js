const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sqs = new SQSClient({});
const TABLE = process.env.TABLE_NAME;

async function getOrder(id) {
  const out = await db.send(new GetCommand({ TableName: TABLE, Key: { id } }));
  return out.Item;
}

async function saveOrder(order) {
  await db.send(new PutCommand({ TableName: process.env.TABLE_NAME, Item: order }));
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(order) }));
}

// Planted trap: deleting needs dynamodb:DeleteItem, which the role does not grant.
async function cancelOrder(id) {
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { id } }));
}

async function archiveReport(body) {
  // Planted trap: this bucket is hardcoded and not in Terraform.
  await s3.send(new PutObjectCommand({ Bucket: 'legacy-reports', Key: 'daily.csv', Body: body }));
}

async function storeUpload(key, body) {
  await s3.send(new PutObjectCommand({ Bucket: process.env.BUCKET, Key: key, Body: body }));
}

exports.handler = async (event) => {
  const method = event.requestContext.http.method;
  if (method === 'DELETE') return cancelOrder(event.pathParameters.id);
  if (method === 'POST' && event.rawPath === '/orders') return saveOrder(JSON.parse(event.body));
  if (method === 'POST' && event.rawPath === '/reports') return archiveReport(event.body);
  if (method === 'PUT') return storeUpload(event.pathParameters.key, event.body);
  return getOrder(event.pathParameters.id);
};

module.exports = { saveOrder, archiveReport, storeUpload };
