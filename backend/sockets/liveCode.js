const AWS = require('aws-sdk');
const Session = require('../models/session');
const User = require('../models/user');
const CodeSummary = require('../models/codeSummary');
const aiService = require('../services/aiService');

// Configure AWS
AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

/**
 * Configure Socket.IO events for live coding
 * @param {Object} io - Socket.IO instance
 */
module.exports = function(io) {
  // Namespace for coding sessions
  const codeIO = io.of('/code');
  
  codeIO.on('connection', (socket) => {
    console.log(`New code socket connected: ${socket.id}`);
    
    // User joins a coding session
    socket.on('join-session', async ({ sessionId, userId }) => {
      try {
        // Join the room
        socket.join(sessionId);
        
        // Get current session data
        const result = await Session.getById(sessionId);
        if (result && result.Item) {
          // Emit current code to the joining user
          socket.emit('session-data', result.Item);
          
          // Notify others that someone joined
          socket.to(sessionId).emit('user-joined', {
            userId,
            timestamp: new Date().toISOString()
          });
          
          console.log(`User ${userId} joined session ${sessionId}`);
        } else {
          socket.emit('error', { message: 'Session not found' });
        }
      } catch (error) {
        console.error('Error joining session:', error);
        socket.emit('error', { message: 'Failed to join session' });
      }
    });
    
    // User updates code
    socket.on('code-update', async (data) => {
      try {
        const { sessionId, code, userId } = data;
        
        // Broadcast to others in the same session
        socket.to(sessionId).emit('code-update', {
          code,
          userId,
          timestamp: new Date().toISOString()
        });
        
        // Update in database (don't wait for it)
        Session.update(sessionId, { currentCode: code })
          .catch(err => console.error('Error updating code in DB:', err));
        
      } catch (error) {
        console.error('Error handling code update:', error);
      }
    });
    
    // Cursor position updates (for showing other users' cursors)
    socket.on('cursor-update', (data) => {
      const { sessionId, position, userId } = data;
      // Broadcast cursor position to others
      socket.to(sessionId).emit('cursor-update', {
        position,
        userId,
        timestamp: new Date().toISOString()
      });
    });
    
    // Slide navigation (for instructor)
    socket.on('slide-change', async (data) => {
      try {
        const { sessionId, slideIndex, userId } = data;
        
        // Broadcast to everyone in session
        socket.to(sessionId).emit('slide-change', {
          slideIndex,
          userId,
          timestamp: new Date().toISOString()
        });
        
        // Update in DB
        Session.update(sessionId, { currentSlide: slideIndex })
          .catch(err => console.error('Error updating slide in DB:', err));
        
      } catch (error) {
        console.error('Error handling slide change:', error);
      }
    });
    
    // Code execution request
    socket.on('execute-code', async (data) => {
      const { sessionId, code, language, userId } = data;
      
      try {
        // Here you would implement code execution
        let result = 'Code execution not implemented yet';
        
        // For JavaScript, you could use a sandboxed eval approach
        if (language === 'javascript') {
          try {
            // WARNING: This is NOT secure for production!
            // Use proper sandboxing solutions for production
            const { VM } = require('vm2');
            const vm = new VM({
              timeout: 1000, // 1 second timeout
              sandbox: {}
            });
            
            result = vm.run(code);
            result = String(result);
          } catch (execError) {
            result = `Error: ${execError.message}`;
          }
        }
        
        // Send execution result to everyone
        codeIO.to(sessionId).emit('execution-result', {
          result,
          userId,
          timestamp: new Date().toISOString()
        });
        
        // Generate AI summary using Google Gemini
        try {
          // Get session info to check if this is a student (not teacher)
          const sessionResult = await Session.getById(sessionId);
          
          if (!sessionResult || !sessionResult.Item) {
            console.error('Session not found for AI summary generation');
            return;
          }
          
          const isTeacher = sessionResult.Item.createdBy === userId;
          
          // Only generate summaries for student code, not teacher demonstrations
          if (!isTeacher) {
            // Get user info
            const userInfo = await User.getById(userId);
            const studentName = userInfo ? userInfo.name || userInfo.email : 'Unknown Student';
            
            // Generate AI summary with Gemini
            const summary = await aiService.generateCodeSummary(
              code, 
              result,
              language,
              studentName
            );
            
            // Generate code quality score
            const qualityScore = await aiService.generateCodeQualityScore(code, language);
            
            // Store the summary
            const summaryData = {
              id: `${sessionId}-${userId}-${Date.now()}`,
              sessionId,
              userId,
              studentName,
              code,
              output: result,
              summary,
              qualityScore,
              timestamp: new Date().toISOString()
            };
            
            await CodeSummary.create(summaryData);
            
            // Send summary to teacher
            const teacherId = sessionResult.Item.createdBy;
            
            // Find and emit to teacher's sockets
            const teacherSockets = await codeIO.fetchSockets();
            const teacherSocket = teacherSockets.find(s => 
              s.data && s.data.userId === teacherId && s.rooms.has(sessionId)
            );
            
            if (teacherSocket) {
              teacherSocket.emit('code-summary', summaryData);
              console.log('Sent Gemini-generated summary to teacher');
            } else {
              console.log('Teacher not connected, summary stored for retrieval');
            }
          }
        } catch (summaryError) {
          console.error('Error generating code summary with Gemini:', summaryError);
        }
        
      } catch (error) {
        console.error('Code execution error:', error);
        socket.emit('error', { message: 'Code execution failed' });
      }
    });
    
    // Store user ID with socket for identifying users
    socket.on('identify', ({ userId }) => {
      if (userId) {
        socket.data = { ...socket.data, userId };
      }
    });
    
    // Request for all pending summaries (teacher reconnecting)
    socket.on('request-pending-summaries', async ({ sessionId, userId }) => {
      try {
        // Verify this is the teacher
        const sessionResult = await Session.getById(sessionId);
        if (sessionResult && sessionResult.Item && 
            sessionResult.Item.createdBy === userId) {
          
          // Get all summaries for this session
          const summaries = await CodeSummary.getBySessionId(sessionId);
          
          // Send them to the teacher
          if (summaries && summaries.Items && summaries.Items.length > 0) {
            socket.emit('pending-summaries', {
              sessionId,
              summaries: summaries.Items
            });
            console.log(`Sent ${summaries.Items.length} pending summaries to teacher`);
          }
        }
      } catch (error) {
        console.error('Error handling pending summaries request:', error);
      }
    });
    
    // User leaves
    socket.on('disconnect', () => {
      console.log(`Code socket disconnected: ${socket.id}`);
    });
  });
  
  return codeIO;
};