const AWS = require('aws-sdk');

// Configure AWS
AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const TABLE_NAME = process.env.SESSIONS_TABLE || 'CodingSessions';

exports.create = async (sessionData) => {
  const params = {
    TableName: TABLE_NAME,
    Item: sessionData
  };
  return await dynamodb.put(params).promise();
};

exports.getById = async (sessionId) => {
  const params = {
    TableName: TABLE_NAME,
    Key: { sessionId }
  };
  return await dynamodb.get(params).promise();
};

exports.update = async (sessionId, updates) => {
  // Dynamically build update expression based on the provided updates
  const updateExpression = [];
  const expressionAttributeValues = {};
  const expressionAttributeNames = {};

  Object.keys(updates).forEach(key => {
    updateExpression.push(`#${key} = :${key}`);
    expressionAttributeValues[`:${key}`] = updates[key];
    expressionAttributeNames[`#${key}`] = key;
  });

  // Add updatedAt timestamp
  updateExpression.push('#updatedAt = :updatedAt');
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();
  expressionAttributeNames['#updatedAt'] = 'updatedAt';

  const params = {
    TableName: TABLE_NAME,
    Key: { sessionId },
    UpdateExpression: `SET ${updateExpression.join(', ')}`,
    ExpressionAttributeValues: expressionAttributeValues,
    ExpressionAttributeNames: expressionAttributeNames,
    ReturnValues: 'ALL_NEW'
  };

  return await dynamodb.update(params).promise();
};

exports.delete = async (sessionId) => {
  const params = {
    TableName: TABLE_NAME,
    Key: { sessionId }
  };
  return await dynamodb.delete(params).promise();
};

exports.getByUser = async (userId) => {
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: 'contains(participants, :userId)',
    ExpressionAttributeValues: {
      ':userId': userId
    }
  };
  return await dynamodb.scan(params).promise();
};

exports.addParticipant = async (sessionId, userId) => {
  const params = {
    TableName: TABLE_NAME,
    Key: { sessionId },
    UpdateExpression: 'SET participants = list_append(participants, :userId)',
    ExpressionAttributeValues: {
      ':userId': [userId]
    },
    ReturnValues: 'ALL_NEW'
  };
  return await dynamodb.update(params).promise();
};