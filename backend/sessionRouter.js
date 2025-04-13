const express = require('express');
const router = express.Router();
const sessionController = require('./sessionController');

// Create a new session (called from Google Slides App Script)
router.post('/create', sessionController.createSession);

// Get session by code
router.get('/:sessionCode', sessionController.getSessionByCode);

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