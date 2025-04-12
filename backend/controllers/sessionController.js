const Session = require('../models/session');
const { generateSessionId } = require('../utils/generateID');

/**
 * Create a new session
 * @route POST /api/sessions
 * @access Private
 */
exports.createSession = async (req, res) => {
  try {
    const { title, description, language, initialCode } = req.body;
    const userId = req.user.id; // Assuming auth middleware populates req.user
    
    const sessionId = generateSessionId();
    
    const sessionData = {
      sessionId,
      title,
      description,
      language: language || 'javascript',
      initialCode: initialCode || '',
      createdBy: userId,
      createdAt: new Date().toISOString(),
      participants: [userId],
      isActive: true
    };
    
    await Session.create(sessionData);
    
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
 * Get session by ID
 * @route GET /api/sessions/:id
 * @access Private
 */
exports.getSessionById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await Session.getById(id);
    
    if (!result.Item) {
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
 * Update session
 * @route PUT /api/sessions/:id
 * @access Private
 */
exports.updateSession = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const userId = req.user.id; // Assuming auth middleware populates req.user
    
    // Get the session first to check permissions
    const result = await Session.getById(id);
    
    if (!result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Check if user is the creator of the session
    if (result.Item.createdBy !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this session'
      });
    }
    
    // Update the session
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
 * Delete session
 * @route DELETE /api/sessions/:id
 * @access Private
 */
exports.deleteSession = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id; // Assuming auth middleware populates req.user
    
    // Get the session first to check permissions
    const result = await Session.getById(id);
    
    if (!result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Check if user is the creator of the session
    if (result.Item.createdBy !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this session'
      });
    }
    
    // Delete the session
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
 * Get all sessions for a user
 * @route GET /api/sessions
 * @access Private
 */
exports.getUserSessions = async (req, res) => {
  try {
    const userId = req.user.id; // Assuming auth middleware populates req.user
    
    const result = await Session.getByUser(userId);
    
    res.status(200).json({
      success: true,
      sessions: result.Items || []
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
 * Join an existing session
 * @route POST /api/sessions/:id/join
 * @access Private
 */
exports.joinSession = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id; // Assuming auth middleware populates req.user
    
    const result = await Session.getById(id);
    
    if (!result.Item) {
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
    
    // Add user to participants if not already there
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
 * End an active session
 * @route PUT /api/sessions/:id/end
 * @access Private
 */
exports.endSession = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id; // Assuming auth middleware populates req.user
    
    const result = await Session.getById(id);
    
    if (!result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Check if user is the creator of the session
    if (result.Item.createdBy !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to end this session'
      });
    }
    
    // End the session
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