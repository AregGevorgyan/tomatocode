const { v4: uuidv4 } = require('uuid');
const { configureDB } = require('./db');

const { docClient } = configureDB();

/**
 * Generates a random 6-digit session code
 * @returns {string} Session code
 */
const generateSessionCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Creates a new coding session
 * @returns {Promise<Object>} Session details
 */
const createSession = async () => {
  const sessionCode = generateSessionCode();
  
  const session = {
    sessionCode,
    createdAt: new Date().toISOString(),
    students: {},
    active: true
  };
  
  await docClient.put({
    TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
    Item: session
  }).promise();
  
  return session;
};

/**
 * Add student to session
 * @param {string} sessionCode - Session code
 * @param {string} studentName - Student name
 * @param {string} socketId - Socket ID
 * @returns {Promise<boolean>} Success status
 */
const addStudentToSession = async (sessionCode, studentName, socketId) => {
  try {
    await docClient.update({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode },
      UpdateExpression: 'SET students.#name = :socketId',
      ExpressionAttributeNames: {
        '#name': studentName
      },
      ExpressionAttributeValues: {
        ':socketId': socketId
      }
    }).promise();
    return true;
  } catch (error) {
    console.error('Error adding student to session:', error);
    return false;
  }
};

module.exports = {
  generateSessionCode,
  createSession,
  addStudentToSession
};