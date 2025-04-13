const express = require('express');
const router = express.Router();
const { createSession } = require('./sessionManager');

// Create a new session (called from Google Slides App Script)
router.post('/create', async (req, res) => {
  try {
    const session = await createSession();
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

// Get session status
router.get('/:sessionCode', async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const { docClient } = require('./db').configureDB();
    
    const result = await docClient.get({
      TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
      Key: { sessionCode }
    }).promise();
    
    if (!result.Item) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    res.json({
      success: true,
      session: result.Item
    });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch session'
    });
  }
});

module.exports = router;