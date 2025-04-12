const AWS = require('aws-sdk');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Configure AWS
AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const TABLE_NAME = process.env.USERS_TABLE || 'Users';

exports.create = async (userData) => {
  // Hash password
  const salt = await bcrypt.genSalt(10);
  userData.password = await bcrypt.hash(userData.password, salt);
  
  // Generate unique ID if none provided
  if (!userData.id) {
    userData.id = uuidv4();
  }
  
  // Add timestamps
  userData.createdAt = new Date().toISOString();
  userData.updatedAt = new Date().toISOString();
  
  const params = {
    TableName: TABLE_NAME,
    Item: userData,
    // Ensure email is unique
    ConditionExpression: 'attribute_not_exists(email)'
  };
  
  try {
    await dynamodb.put(params).promise();
    return { ...userData, password: undefined }; // Return user without password
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') {
      throw new Error('User with this email already exists');
    }
    throw error;
  }
};

exports.getById = async (id) => {
  const params = {
    TableName: TABLE_NAME,
    Key: { id }
  };
  const result = await dynamodb.get(params).promise();
  return result.Item;
};

exports.getByEmail = async (email) => {
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':email': email
    }
  };
  
  const result = await dynamodb.scan(params).promise();
  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
};

exports.update = async (id, updates) => {
  // Don't allow email updates through this method (would need to check uniqueness)
  delete updates.email;
  
  // Hash password if it's being updated
  if (updates.password) {
    const salt = await bcrypt.genSalt(10);
    updates.password = await bcrypt.hash(updates.password, salt);
  }
  
  // Add updated timestamp
  updates.updatedAt = new Date().toISOString();
  
  // Build update expressions
  const updateExpression = [];
  const expressionAttributeValues = {};
  const expressionAttributeNames = {};
  
  Object.keys(updates).forEach(key => {
    updateExpression.push(`#${key} = :${key}`);
    expressionAttributeValues[`:${key}`] = updates[key];
    expressionAttributeNames[`#${key}`] = key;
  });
  
  const params = {
    TableName: TABLE_NAME,
    Key: { id },
    UpdateExpression: `SET ${updateExpression.join(', ')}`,
    ExpressionAttributeValues: expressionAttributeValues,
    ExpressionAttributeNames: expressionAttributeNames,
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.update(params).promise();
  return result.Attributes;
};

exports.comparePassword = async (plainPassword, hashedPassword) => {
  return await bcrypt.compare(plainPassword, hashedPassword);
};