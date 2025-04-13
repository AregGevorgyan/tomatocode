const { configureDB } = require('./db');
const { v4: uuidv4 } = require('uuid');

// Get DynamoDB document client
const { docClient } = configureDB();
const SESSIONS_TABLE = process.env.SESSIONS_TABLE || 'CodingSessions';
const SUMMARIES_TABLE = process.env.SUMMARIES_TABLE || 'CodeSummaries';

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
      TableName: SESSIONS_TABLE,
      Key: { sessionCode: code }
    }).promise();
    if (!result || !result.Item) {
      exists = false;
    }
  } while (exists);
  return code;
};

/**
 * Create a new session.
 * @route POST /api/sessions/create
 * @access Public
 */
exports.createSession = async (req, res) => {
  try {
    const { title, description, language, initialCode } = req.body;

    // Generate a unique session code (6 lowercase letters)
    const sessionCode = await generateUniqueSessionCode();

    // Prepare session data with added fields for live updates
    const sessionData = {
      sessionCode,
      title: title || 'Coding Session',
      description: description || 'Interactive coding session',
      language: language || 'javascript',
      initialCode: initialCode || '',
      currentCode: initialCode || '',  // For live code updates
      slides: [],                      // Array to store slide data
      currentSlide: 0,                 // Current slide index
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      students: {},                   // Will store student data
      active: true
    };

    // Create the session in the database
    await docClient.put({
      TableName: SESSIONS_TABLE,
      Item: sessionData
    }).promise();

    // Send success response
    res.status(201).json({
      success: true,
      sessionCode,
      message: 'Session created successfully'
    });
  } catch (error) {
    console.error('Create Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create session',
      error: error.message
    });
  }
};

/**
 * Get session by code
 * @route GET /api/sessions/:sessionCode
 * @access Public
 */
exports.getSessionByCode = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const result = await docClient.get({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode }
    }).promise();
    
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    res.status(200).json({
      success: true,
      session: result.Item
    });
  } catch (error) {
    console.error('Get Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve session',
      error: error.message
    });
  }
};

/**
 * Update session information
 * @route PUT /api/sessions/:sessionCode
 * @access Public (Teacher with correct session code)
 */
exports.updateSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const updates = req.body;
    
    // Check if session exists
    const result = await docClient.get({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode }
    }).promise();
    
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Build the update expression dynamically
    let updateExpression = 'SET updatedAt = :updatedAt';
    const expressionAttributeNames = {};
    const expressionAttributeValues = {
      ':updatedAt': new Date().toISOString()
    };
    
    Object.entries(updates).forEach(([key, value], index) => {
      // Skip reserved keys
      if (['sessionCode', 'createdAt'].includes(key)) return;
      
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      
      updateExpression += `, ${attrName} = ${attrValue}`;
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = value;
    });
    
    await docClient.update({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    }).promise();
    
    res.status(200).json({
      success: true,
      message: 'Session updated successfully'
    });
  } catch (error) {
    console.error('Update Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update session',
      error: error.message
    });
  }
};

/**
 * Delete session
 * @route DELETE /api/sessions/:sessionCode
 * @access Public (Teacher with correct session code)
 */
exports.deleteSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    
    // Check if session exists
    const result = await docClient.get({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode }
    }).promise();
    
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    await docClient.delete({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode }
    }).promise();
    
    res.status(200).json({
      success: true,
      message: 'Session deleted successfully'
    });
  } catch (error) {
    console.error('Delete Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete session',
      error: error.message
    });
  }
};

/**
 * Join an existing session as a student
 * @route POST /api/sessions/:sessionCode/join
 * @access Public
 */
exports.joinSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const { studentName } = req.body;
    
    if (!studentName) {
      return res.status(400).json({
        success: false,
        message: 'Student name is required'
      });
    }

    const result = await docClient.get({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode }
    }).promise();
    
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    if (!result.Item.active) {
      return res.status(400).json({
        success: false,
        message: 'This session is no longer active'
      });
    }
    
    // Add student to session
    await docClient.update({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode },
      UpdateExpression: 'SET students.#name = :studentData',
      ExpressionAttributeNames: {
        '#name': studentName
      },
      ExpressionAttributeValues: {
        ':studentData': {
          joinedAt: new Date().toISOString(),
          code: '',
          lastActive: new Date().toISOString()
        }
      }
    }).promise();
    
    res.status(200).json({
      success: true,
      message: 'Joined session successfully',
      session: result.Item
    });
  } catch (error) {
    console.error('Join Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to join session',
      error: error.message
    });
  }
};

/**
 * End an active session
 * @route PUT /api/sessions/:sessionCode/end
 * @access Public (Teacher with session code)
 */
exports.endSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    
    const result = await docClient.get({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode }
    }).promise();
    
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    await docClient.update({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode },
      UpdateExpression: 'SET active = :active, updatedAt = :updatedAt',
      ExpressionAttributeValues: { 
        ':active': false,
        ':updatedAt': new Date().toISOString()
      }
    }).promise();
    
    res.status(200).json({
      success: true,
      message: 'Session ended successfully'
    });
  } catch (error) {
    console.error('End Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to end session',
      error: error.message
    });
  }
};

/**
 * Update current slide for a session
 * @route PUT /api/sessions/:sessionCode/slide/:slideIndex
 * @access Public (Teacher with session code)
 */
exports.updateCurrentSlide = async (req, res) => {
  try {
    const { sessionCode, slideIndex } = req.params;
    const slideNum = parseInt(slideIndex, 10);
    
    if (isNaN(slideNum) || slideNum < 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid slide index'
      });
    }
    
    const result = await docClient.get({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode }
    }).promise();
    
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    await docClient.update({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode },
      UpdateExpression: 'SET currentSlide = :slide, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':slide': slideNum,
        ':updatedAt': new Date().toISOString()
      }
    }).promise();
    
    res.status(200).json({
      success: true,
      message: 'Current slide updated successfully'
    });
  } catch (error) {
    console.error('Update Slide Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update current slide',
      error: error.message
    });
  }
};

/**
 * Update student code in a session
 * @param {string} sessionCode - Session code
 * @param {string} studentName - Student name
 * @param {string} code - Student's code
 * @returns {Promise<boolean>} Success status
 */
exports.updateStudentCode = async (sessionCode, studentName, code) => {
  try {
    await docClient.update({
      TableName: SESSIONS_TABLE,
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
 * Get all code summaries for a session
 * @route GET /api/sessions/:sessionCode/summaries
 * @access Public (Teacher only with session code)
 */
exports.getSessionSummaries = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    
    // Verify the session exists
    const sessionResult = await docClient.get({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode }
    }).promise();
    
    if (!sessionResult || !sessionResult.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Get all summaries for this session
    const summariesResult = await docClient.query({
      TableName: SUMMARIES_TABLE,
      IndexName: 'SessionCodeIndex',
      KeyConditionExpression: 'sessionCode = :code',
      ExpressionAttributeValues: { ':code': sessionCode }
    }).promise();
    
    res.status(200).json({
      success: true,
      summaries: summariesResult.Items || []
    });
  } catch (error) {
    console.error('Error fetching session summaries:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve session summaries',
      error: error.message
    });
  }
};

/**
 * Get summaries for a specific student in a session
 * @route GET /api/sessions/:sessionCode/students/:studentName/summaries
 * @access Public (With session code)
 */
exports.getStudentSummaries = async (req, res) => {
  try {
    const { sessionCode, studentName } = req.params;
    
    // Verify the session exists
    const sessionResult = await docClient.get({
      TableName: SESSIONS_TABLE,
      Key: { sessionCode }
    }).promise();
    
    if (!sessionResult || !sessionResult.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Check if student exists in session
    if (!sessionResult.Item.students || !sessionResult.Item.students[studentName]) {
      return res.status(404).json({
        success: false,
        message: 'Student not found in this session'
      });
    }
    
    // Get summaries for this student in this session
    const summariesResult = await docClient.query({
      TableName: SUMMARIES_TABLE,
      IndexName: 'SessionCodeIndex',
      KeyConditionExpression: 'sessionCode = :code',
      FilterExpression: 'studentName = :name',
      ExpressionAttributeValues: { 
        ':code': sessionCode,
        ':name': studentName 
      }
    }).promise();
    
    res.status(200).json({
      success: true,
      summaries: summariesResult.Items || []
    });
  } catch (error) {
    console.error('Error fetching student summaries:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve student summaries',
      error: error.message
    });
  }
};

// Export additional utility functions that liveCode.js might need
exports.generateSessionCode = generateSessionCode;
exports.generateUniqueSessionCode = generateUniqueSessionCode;