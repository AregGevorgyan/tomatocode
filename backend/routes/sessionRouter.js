const express = require('express');
const router = express.Router();
const sessionController = require('../controllers/sessionController');
const auth = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(auth);

// Session CRUD operations
router.post('/', sessionController.createSession);
router.get('/', sessionController.getUserSessions);
router.get('/:id', sessionController.getSessionById);
router.put('/:id', sessionController.updateSession);
router.delete('/:id', sessionController.deleteSession);

// Session participation
router.post('/:id/join', sessionController.joinSession);
router.put('/:id/end', sessionController.endSession);

// AI summary routes
router.get('/:id/summaries', sessionController.getSessionSummaries);
router.get('/:id/users/:userId/summaries', sessionController.getStudentSummaries);

module.exports = router;