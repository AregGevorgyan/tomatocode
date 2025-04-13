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

// Session model for sessionController references
const Session = {
  // Get session by sessionCode
  getById: async (sessionCode) => {
    const { docClient } = configureDB();
    return docClient.get({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode }
    }).promise();
  },
  
  // Create a new session
  create: async (sessionData) => {
    const { docClient } = configureDB();
    return docClient.put({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Item: sessionData
    }).promise();
  },
  
  // Update an existing session
  update: async (sessionCode, updates) => {
    const { docClient } = configureDB();
    
    // Build the update expression dynamically
    let updateExpression = 'SET ';
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    
    Object.entries(updates).forEach(([key, value], index) => {
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      
      updateExpression += `${index > 0 ? ', ' : ''}${attrName} = ${attrValue}`;
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = value;
    });
    
    return docClient.update({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    }).promise();
  },
  
  // Add participant to session
  addParticipant: async (sessionCode, studentName) => {
    const { docClient } = configureDB();
    return docClient.update({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode },
      UpdateExpression: 'SET students.#name = if_not_exists(students.#name, :emptyObj)',
      ExpressionAttributeNames: { '#name': studentName },
      ExpressionAttributeValues: { ':emptyObj': { joinedAt: new Date().toISOString() } }
    }).promise();
  },
  
  // Update student data (code, summary, etc.)
  updateStudentData: async (sessionCode, studentName, updates) => {
    const { docClient } = configureDB();
    
    const updateExpressions = [];
    const expressionAttributeNames = { '#student': studentName };
    const expressionAttributeValues = {};
    
    Object.entries(updates).forEach(([key, value], index) => {
      const keyName = `#key${index}`;
      const valueName = `:val${index}`;
      updateExpressions.push(`students.#student.${keyName} = ${valueName}`);
      expressionAttributeNames[keyName] = key;
      expressionAttributeValues[valueName] = value;
    });
    
    return docClient.update({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    }).promise();
  },
  
  // Update current slide
  updateCurrentSlide: async (sessionCode, slideIndex) => {
    const { docClient } = configureDB();
    return docClient.update({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode },
      UpdateExpression: 'SET currentSlide = :slide',
      ExpressionAttributeValues: { ':slide': slideIndex }
    }).promise();
  },
  
  // Delete a session
  delete: async (sessionCode) => {
    const { docClient } = configureDB();
    return docClient.delete({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode }
    }).promise();
  },
  
  // Get sessions by user ID for future auth implementation if needed
  getByUser: async (userId) => {
    const { docClient } = configureDB();
    // This would typically use a GSI in a real implementation
    return { Items: [] }; // Placeholder return for no-auth version
  }
};

// CodeSummary model for sessionController references
const CodeSummary = {
  create: async (summaryData) => {
    const { docClient } = configureDB();
    return docClient.put({
      TableName: process.env.SUMMARIES_TABLE || 'CodeSummaries',
      Item: {
        id: Date.now().toString(),
        createdAt: new Date().toISOString(),
        ...summaryData
      }
    }).promise();
  },
  
  getById: async (id) => {
    const { docClient } = configureDB();
    return docClient.get({
      TableName: process.env.SUMMARIES_TABLE || 'CodeSummaries',
      Key: { id }
    }).promise();
  },
  
  getBySessionId: async (sessionCode) => {
    const { docClient } = configureDB();
    return docClient.query({
      TableName: process.env.SUMMARIES_TABLE || 'CodeSummaries',
      IndexName: 'SessionCodeIndex',
      KeyConditionExpression: 'sessionCode = :code',
      ExpressionAttributeValues: { ':code': sessionCode }
    }).promise();
  },
  
  getByStudentInSession: async (sessionCode, studentName) => {
    const { docClient } = configureDB();
    return docClient.query({
      TableName: process.env.SUMMARIES_TABLE || 'CodeSummaries',
      IndexName: 'SessionCodeIndex',
      KeyConditionExpression: 'sessionCode = :code',
      FilterExpression: 'studentName = :name',
      ExpressionAttributeValues: { 
        ':code': sessionCode,
        ':name': studentName 
      }
    }).promise();
  }
};

module.exports = { 
  configureDB, 
  setupTables,
  Session,
  CodeSummary 
};