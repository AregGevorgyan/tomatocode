const AWS = require('aws-sdk');
const { VM } = require('vm2');

// Configure AWS
AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = new AWS.DynamoDB.DocumentClient();

/**
 * Configure Socket.IO events for live coding
 * @param {Object} io - Socket.IO instance
 */
module.exports = function(io) {
  // Namespace for coding sessions
  const codeIO = io.of('/code');
  
  codeIO.on('connection', (socket) => {
    console.log(`New code socket connected: ${socket.id}`);
    
    // User joins a coding session with session code
    socket.on('join-session', async ({ sessionCode, name }) => {
      try {
        // Verify session exists
        const result = await docClient.get({
          TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
          Key: { sessionCode }
        }).promise();
        
        if (!result.Item) {
          socket.emit('error', { message: 'Invalid session code' });
          return;
        }
        
        // Join the socket room
        socket.join(sessionCode);
        
        // Store user data with socket
        socket.data = { 
          name, 
          sessionCode,
          isTeacher: false // Students join via session code
        };
        
        // Update DynamoDB to track student
        const socketId = socket.id;
        await docClient.update({
          TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
          Key: { sessionCode },
          UpdateExpression: 'SET students.#name = :socketId',
          ExpressionAttributeNames: { '#name': name },
          ExpressionAttributeValues: { ':socketId': socketId }
        }).promise();
        
        // Send current session data to the joining user
        socket.emit('session-data', result.Item);
        
        // Notify others that someone joined
        socket.to(sessionCode).emit('user-joined', {
          name,
          timestamp: new Date().toISOString()
        });
        
        console.log(`User ${name} joined session ${sessionCode}`);
      } catch (error) {
        console.error('Error joining session:', error);
        socket.emit('error', { message: 'Failed to join session' });
      }
    });
    
    // Teacher creates and joins session (called after HTTP endpoint creates session)
    socket.on('teacher-join', async ({ sessionCode, name }) => {
      try {
        // Join the socket room
        socket.join(sessionCode);
        
        // Mark this socket as the teacher
        socket.data = { 
          name, 
          sessionCode, 
          isTeacher: true 
        };
        
        console.log(`Teacher ${name} joined session ${sessionCode}`);
      } catch (error) {
        console.error('Error with teacher join:', error);
        socket.emit('error', { message: 'Failed to join as teacher' });
      }
    });
    
    // User updates code
    socket.on('code-update', async (data) => {
      try {
        const { code } = data;
        const sessionCode = socket.data?.sessionCode;
        
        if (!sessionCode) {
          socket.emit('error', { message: 'Not in a session' });
          return;
        }
        
        // Broadcast to others in the same session
        socket.to(sessionCode).emit('code-update', {
          code,
          name: socket.data.name,
          timestamp: new Date().toISOString()
        });
        
        // Update in database if this is from teacher
        if (socket.data.isTeacher) {
          await docClient.update({
            TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
            Key: { sessionCode },
            UpdateExpression: 'SET currentCode = :code',
            ExpressionAttributeValues: { ':code': code }
          }).promise();
        }
      } catch (error) {
        console.error('Error handling code update:', error);
      }
    });
    
    // Cursor position updates (for showing other users' cursors)
    socket.on('cursor-update', (data) => {
      const { position } = data;
      const sessionCode = socket.data?.sessionCode;
      
      if (!sessionCode) return;
      
      // Broadcast cursor position to others
      socket.to(sessionCode).emit('cursor-update', {
        position,
        name: socket.data.name,
        timestamp: new Date().toISOString()
      });
    });
    
    // Code execution request
    socket.on('execute-code', async (data) => {
      const { code, language } = data;
      const sessionCode = socket.data?.sessionCode;
      
      if (!sessionCode) {
        socket.emit('error', { message: 'Not in a session' });
        return;
      }
      
      try {
        // Execute code (currently supports JavaScript only)
        let result = 'Code execution not implemented for this language';
        
        if (language === 'javascript') {
          try {
            // Using VM2 for safer execution
            const vm = new VM({
              timeout: 1000,
              sandbox: {}
            });
            
            result = vm.run(code);
            result = String(result);
          } catch (execError) {
            result = `Error: ${execError.message}`;
          }
        }
        
        // Send execution result to everyone in the session
        codeIO.to(sessionCode).emit('execution-result', {
          result,
          name: socket.data.name,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Code execution error:', error);
        socket.emit('error', { message: 'Code execution failed' });
      }
    });
    
    // User leaves or disconnects
    socket.on('disconnect', async () => {
      try {
        const { sessionCode, name } = socket.data || {};
        console.log(`Socket disconnected: ${socket.id}, User: ${name || 'Unknown'}`);
        
        if (sessionCode && name) {
          // Notify others that user left
          socket.to(sessionCode).emit('user-left', {
            name,
            timestamp: new Date().toISOString()
          });
          
          // Remove from students list if not teacher
          if (!socket.data.isTeacher) {
            await docClient.update({
              TableName: process.env.SESSIONS_TABLE || 'CodingSessions',
              Key: { sessionCode },
              UpdateExpression: 'REMOVE students.#name',
              ExpressionAttributeNames: { '#name': name }
            }).promise();
          }
        }
      } catch (error) {
        console.error('Error handling disconnection:', error);
      }
    });
  });
  
  return codeIO;
};