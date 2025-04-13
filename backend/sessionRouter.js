const express = require('express');
const router = express.Router();
const sessionController = require('./sessionController');
const { getSession, createSession } = require('./sessionManager');

// Create a new session (called from Google Slides App Script)
router.post('/create', async (req, res) => {
  try {
    // Use options from request body if provided
    const { title, description, language, initialCode } = req.body;
    const session = await createSession({ title, description, language, initialCode });
    
    res.json({
      success: true,
      sessionCode: session.sessionCode
    });
  } catch (error) {
    console.error('Failed to create session:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create session'
    });
  }
});

// Get session by code
router.get('/:sessionCode', async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const session = await getSession(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    res.json({
      success: true,
      session
    });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch session'
    });
  }
});

// Update session information
router.put('/:sessionCode', sessionController.updateSession);

// Delete session
router.delete('/:sessionCode', sessionController.deleteSession);

// Join a session as a student
router.post('/:sessionCode/join', sessionController.joinSession);

// End a session
router.put('/:sessionCode/end', sessionController.endSession);

// Update current slide
router.put('/:sessionCode/slide/:slideIndex', sessionController.updateCurrentSlide);

// Get all summaries for a session
router.get('/:sessionCode/summaries', sessionController.getSessionSummaries);

// Get summaries for a specific student
router.get('/:sessionCode/students/:studentName/summaries', sessionController.getStudentSummaries);

module.exports = router;