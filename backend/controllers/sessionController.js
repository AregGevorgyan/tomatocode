const Session = require('../models/session');

/**
 * Generate a random string of lowercase letters of given length.
 * @param {number} length - Number of characters.
 * @returns {string} - Random lowercase string.
 */
function generateRandomLowercase(length = 6) {
  let result = '';
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

/**
 * Generate a unique session ID that is 6 lowercase letters long.
 * This function checks the database to ensure that the generated code
 * does not already exist.
 * @returns {Promise<string>}
 */
async function generateUniqueSessionId() {
  let code;
  let exists = true;
  do {
    code = generateRandomLowercase(6);
    // Assuming Session.getById returns a result with an "Item" property if found.
    const result = await Session.getById(code);
    if (!result || !result.Item) {
      exists = false;
    }
  } while (exists);
  return code;
}

/**
 * Create a new session.
 * @route POST /api/sessions
 * @access Private
 */
exports.createSession = async (req, res) => {
  try {
    const { title, description, language, initialCode } = req.body;
    const userId = req.user.id; // Assuming auth middleware populates req.user

    // Generate a unique session ID (6 lowercase letters).
    const sessionId = await generateUniqueSessionId();

    // Prepare session data with added fields for live updates.
    const sessionData = {
      sessionId,
      title,
      description,
      language: language || 'javascript',
      initialCode: initialCode || '',
      currentCode: initialCode || '',  // For live code updates.
      slides: [],                      // Array to store slide data.
      currentSlide: 0,                 // Current slide index.
      createdBy: userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      participants: [userId],
      isActive: true
    };

    // Create the session in the database.
    await Session.create(sessionData);

    // Send success response.
    res.status(201).json({
      success: true,
      sessionId,
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
 * Get session by ID.
 * @route GET /api/sessions/:id
 * @access Private
 */
exports.getSessionById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await Session.getById(id);
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
 * Update session.
 * @route PUT /api/sessions/:id
 * @access Private
 */
exports.updateSession = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const userId = req.user.id;

    const result = await Session.getById(id);
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    if (result.Item.createdBy !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this session'
      });
    }
    await Session.update(id, updates);
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
 * Delete session.
 * @route DELETE /api/sessions/:id
 * @access Private
 */
exports.deleteSession = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const result = await Session.getById(id);
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    if (result.Item.createdBy !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this session'
      });
    }
    await Session.delete(id);
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
 * Get all sessions for a user.
 * @route GET /api/sessions
 * @access Private
 */
exports.getUserSessions = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await Session.getByUser(userId);
    res.status(200).json({
      success: true,
      sessions: (result.Items && result.Items.length ? result.Items : [])
    });
  } catch (error) {
    console.error('Get User Sessions Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve user sessions',
      error: error.message
    });
  }
};

/**
 * Join an existing session.
 * @route POST /api/sessions/:id/join
 * @access Private
 */
exports.joinSession = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const result = await Session.getById(id);
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    if (!result.Item.isActive) {
      return res.status(400).json({
        success: false,
        message: 'This session is no longer active'
      });
    }
    // Add user to participants if not already present.
    if (!result.Item.participants.includes(userId)) {
      await Session.addParticipant(id, userId);
    }
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
 * End an active session.
 * @route PUT /api/sessions/:id/end
 * @access Private
 */
exports.endSession = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const result = await Session.getById(id);
    if (!result || !result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    if (result.Item.createdBy !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to end this session'
      });
    }
    await Session.update(id, { isActive: false });
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