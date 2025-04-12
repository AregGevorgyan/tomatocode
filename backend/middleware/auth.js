// auth.js
const jwt = require('jsonwebtoken');
const AWS = require('aws-sdk');

// Configure AWS region (adjust as necessary or use environment variables)
AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

// JWT secret – this should be stored securely (e.g., an environment variable)
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';

// The name of your DynamoDB table for users can be stored in an environment variable
const USERS_TABLE = process.env.USERS_TABLE || 'Users';

/**
 * Authentication middleware
 *  - Expects a Bearer token in the Authorization header.
 *  - Verifies the token and decodes it.
 *  - Uses the decoded user id to fetch the user from DynamoDB.
 *  - Attaches the user object to req.user.
 */
module.exports = async (req, res, next) => {
  try {
    // Check for the Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    // Extract the token from the header
    const token = authHeader.split(' ')[1];

    // Verify the JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (tokenError) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
        error: tokenError.message
      });
    }

    // Assuming the token payload includes the user id in decoded.id
    const userId = decoded.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token payload'
      });
    }

    // Prepare parameters to get the user from DynamoDB
    const params = {
      TableName: USERS_TABLE,
      Key: { id: userId }
    };

    // Retrieve the user
    const result = await dynamodb.get(params).promise();

    // If the user doesn't exist, return an error
    if (!result.Item) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Attach the user object to the request so that later middleware and controllers can use it
    req.user = result.Item;
    next();
  } catch (error) {
    console.error('Auth Middleware Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error in auth middleware',
      error: error.message
    });
  }
};
