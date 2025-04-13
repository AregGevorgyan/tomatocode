const AWS = require('aws-sdk');
require('dotenv').config();

// Configure AWS
const region = process.env.AWS_REGION || 'us-east-1';

const configureDB = () => {
  // Configure AWS SDK
  AWS.config.update({
    region,
    // For local development, use these
    ...(process.env.NODE_ENV !== 'production' && {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    })
    // In production on EC2 with IAM roles, credentials are automatically provided
  });

  // Create DynamoDB instance
  const dynamodb = new AWS.DynamoDB();
  const docClient = new AWS.DynamoDB.DocumentClient();

  return { dynamodb, docClient };
};

// Helper to create required tables if they don't exist
const setupTables = async () => {
  if (process.env.NODE_ENV === 'production') {
    console.log('Skipping table creation in production environment');
    return;
  }

  const { dynamodb } = configureDB();

  // Create Sessions table with sessionCode as primary key
  const sessionTableParams = {
    TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
    KeySchema: [{ AttributeName: 'sessionCode', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'sessionCode', AttributeType: 'S' }],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5
    }
  };
  
  // Create Summaries table keyed by unique summary ID with sessionCode GSI
  const summaryTableParams = {
    TableName: process.env.SUMMARIES_TABLE || 'CodeSummaries',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'sessionCode', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'SessionCodeIndex',
        KeySchema: [{ AttributeName: 'sessionCode', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5
        }
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5
    }
  };
  
  try {
    await dynamodb.createTable(summaryTableParams).promise();
    console.log(`Created table: ${summaryTableParams.TableName}`);
  } catch (e) {
    if (e.code === 'ResourceInUseException') {
      console.log(`Table already exists: ${summaryTableParams.TableName}`);
    } else {
      console.error(`Error creating table ${summaryTableParams.TableName}:`, e);
    }
  }

  try {
    await dynamodb.createTable(sessionTableParams).promise();
    console.log(`Created table: ${sessionTableParams.TableName}`);
  } catch (e) {
    if (e.code === 'ResourceInUseException') {
      console.log(`Table already exists: ${sessionTableParams.TableName}`);
    } else {
      console.error(`Error creating table ${sessionTableParams.TableName}:`, e);
    }
  }
};

module.exports = { configureDB, setupTables };