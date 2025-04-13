const { configureDB } = require('./db');

const { docClient } = configureDB();

/**
 * Generates a random string of lowercase letters of given length.
 * @param {number} length - Number of characters.
 * @returns {string} - Random lowercase string.
 */
const generateSessionCode = (length = 6) => {
  let result = '';
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
};

/**
 * Generate a unique session code that doesn't exist in the database
 * @returns {Promise<string>} Unique session code
 */
const generateUniqueSessionCode = async () => {
  let code;
  let exists = true;
  do {
    code = generateSessionCode();
    const result = await docClient.get({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode: code }
    }).promise();
    if (!result || !result.Item) {
      exists = false;
    }
  } while (exists);
  return code;
};

/**
 * Creates a new coding session
 * @param {Object} options - Optional session parameters
 * @param {string} options.title - Session title
 * @param {string} options.description - Session description
 * @param {string} options.language - Programming language
 * @param {string} options.initialCode - Initial code for editor
 * @returns {Promise<Object>} Session details
 */
const createSession = async (options = {}) => {
  const sessionCode = await generateUniqueSessionCode();
  
  const session = {
    sessionCode,
    title: options.title || 'Coding Session',
    description: options.description || 'Interactive coding session',
    language: options.language || 'javascript',
    initialCode: options.initialCode || '',
    currentCode: options.initialCode || '',
    slides: [],
    currentSlide: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
      UpdateExpression: 'SET students.#name = :studentData',
      ExpressionAttributeNames: {
        '#name': studentName
      },
      ExpressionAttributeValues: {
        ':studentData': {
          socketId,
          joinedAt: new Date().toISOString(),
          code: '',
          lastActive: new Date().toISOString()
        }
      }
    }).promise();
    return true;
  } catch (error) {
    console.error('Error adding student to session:', error);
    return false;
  }
};

/**
 * Update student code in a session
 * @param {string} sessionCode - Session code
 * @param {string} studentName - Student name
 * @param {string} code - Student's code
 * @returns {Promise<boolean>} Success status
 */
const updateStudentCode = async (sessionCode, studentName, code) => {
  try {
    await docClient.update({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode },
      UpdateExpression: 'SET students.#name.code = :code, students.#name.lastActive = :lastActive',
      ExpressionAttributeNames: {
        '#name': studentName
      },
      ExpressionAttributeValues: {
        ':code': code,
        ':lastActive': new Date().toISOString()
      }
    }).promise();
    return true;
  } catch (error) {
    console.error('Error updating student code:', error);
    return false;
  }
};

/**
 * Update current slide in a session
 * @param {string} sessionCode - Session code
 * @param {number} slideIndex - Slide index
 * @returns {Promise<boolean>} Success status
 */
const updateCurrentSlide = async (sessionCode, slideIndex) => {
  try {
    await docClient.update({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode },
      UpdateExpression: 'SET currentSlide = :slide',
      ExpressionAttributeValues: {
        ':slide': slideIndex
      }
    }).promise();
    return true;
  } catch (error) {
    console.error('Error updating current slide:', error);
    return false;
  }
};

/**
 * Get session details by code
 * @param {string} sessionCode - Session code
 * @returns {Promise<Object|null>} Session object or null if not found
 */
const getSession = async (sessionCode) => {
  try {
    const result = await docClient.get({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode }
    }).promise();
    
    return result.Item || null;
  } catch (error) {
    console.error('Error getting session:', error);
    return null;
  }
};

module.exports = {
  generateSessionCode,
  generateUniqueSessionCode,
  createSession,
  addStudentToSession,
  updateStudentCode,
  updateCurrentSlide,
  getSession
};