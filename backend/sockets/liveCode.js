const AWS = require('aws-sdk');
const Session = require('../models/session');

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
      const { sessionId, code, language } = data;
      
      try {
        // Here you would implement code execution
        // For a hackathon, could use a simple approach:
        
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
        io.to(sessionId).emit('execution-result', {
          result,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        console.error('Code execution error:', error);
        socket.emit('error', { message: 'Code execution failed' });
      }
    });
    
    // User leaves
    socket.on('disconnect', () => {
      console.log(`Code socket disconnected: ${socket.id}`);
    });
  });
  
  return codeIO;
};