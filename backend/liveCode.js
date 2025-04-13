const AWS = require('aws-sdk');
const { VM } = require('vm2');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const sessionController = require('./sessionController');
const { configureDB } = require('./db');

// Convert exec to promise-based with timeout
const execPromise = (command, options = {}) => {
  return new Promise((resolve, reject) => {
    const process = exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    
    // Handle timeout
    if (options.timeout) {
      setTimeout(() => {
        process.kill();
        reject(new Error(`Execution timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
  });
};

// Configure AWS
AWS.config.update({ region: process.env.AWS_REGION || 'us-east-1' });
const { docClient } = configureDB();
const SESSIONS_TABLE = process.env.SESSIONS_TABLE || 'CodingSessions';

// Import AI summary functionality (to be implemented)
let generateCodeSummary;
try {
  const AISummary = require('./AIsummery');
  generateCodeSummary = AISummary.generateCodeSummary;
} catch (error) {
  console.warn('AI summary module not found or incomplete, summaries will be disabled');
  generateCodeSummary = async () => ({ summary: 'No summary available', progress: 'unknown' });
}

/**
 * Configure Socket.IO events for live coding
 * @param {Object} io - Socket.IO instance
 */
module.exports = function(io) {
  // Namespace for coding sessions
  const codeIO = io.of('/code');
  
  // Track periodic summary updates
  const summaryTimers = new Map();
  
  // Create temp directory if it doesn't exist
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }
  
  codeIO.on('connection', (socket) => {
    console.log(`New code socket connected: ${socket.id}`);
    
    // User joins a coding session with session code
    socket.on('join-session', async ({ sessionCode, name }) => {
      try {
        // Verify session exists
        const result = await docClient.get({
          TableName: SESSIONS_TABLE,
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
        
        // Add student to session directly using controller's method
        // Use a simplified version of joinSession logic
        await docClient.update({
          TableName: SESSIONS_TABLE,
          Key: { sessionCode },
          UpdateExpression: 'SET students.#name = :studentData',
          ExpressionAttributeNames: {
            '#name': name
          },
          ExpressionAttributeValues: {
            ':studentData': {
              joinedAt: new Date().toISOString(),
              code: '',
              socketId: socket.id,
              lastActive: new Date().toISOString()
            }
          }
        }).promise();
        
        // Send current session data to the joining user
        socket.emit('session-data', result.Item);
        
        // Send current slide to newly joined student
        socket.emit('slide-change', {
          index: result.Item.currentSlide || 0
        });
        
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
        
        // Start periodic summary updates when teacher joins
        if (!summaryTimers.has(sessionCode)) {
          const timer = setInterval(async () => {
            try {
              await updateStudentSummaries(sessionCode);
            } catch (error) {
              console.error('Error updating summaries:', error);
            }
          }, 30000); // Update summaries every 30 seconds
          
          summaryTimers.set(sessionCode, timer);
        }
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
        const name = socket.data?.name;
        
        if (!sessionCode || !name) {
          socket.emit('error', { message: 'Not in a session' });
          return;
        }
        
        // Broadcast to teacher only if from student
        if (!socket.data.isTeacher) {
          // Update student code in database using controller function
          await sessionController.updateStudentCode(sessionCode, name, code);
          
          // Get teacher sockets in this session
          const teacherSockets = await codeIO.in(sessionCode).fetchSockets();
          const teachers = teacherSockets.filter(s => s.data?.isTeacher);
          
          // Send code update only to teachers
          teachers.forEach(teacher => {
            teacher.emit('student-code-update', {
              studentName: name,
              code,
              timestamp: new Date().toISOString()
            });
          });
          
          // Generate updated summary if code changed significantly
          if (code.length > 10) {
            try {
              // Get session to find task description
              const sessionResult = await docClient.get({
                TableName: SESSIONS_TABLE,
                Key: { sessionCode }
              }).promise();
              
              const task = sessionResult.Item?.currentTask || 'Coding task';
              
              // Generate AI summary
              const summary = await generateCodeSummary(code, task);
              
              // Store summary with student data
              await docClient.update({
                TableName: SESSIONS_TABLE,
                Key: { sessionCode },
                UpdateExpression: 'SET students.#name.summary = :summary',
                ExpressionAttributeNames: { '#name': name },
                ExpressionAttributeValues: { ':summary': summary }
              }).promise();
              
              // Send to teachers
              teachers.forEach(teacher => {
                teacher.emit('student-summary-update', {
                  studentName: name,
                  summary,
                  timestamp: new Date().toISOString()
                });
              });
            } catch (summaryError) {
              console.error('Error generating summary:', summaryError);
            }
          }
        } else {
          // If from teacher, update in database
          await docClient.update({
            TableName: SESSIONS_TABLE,
            Key: { sessionCode },
            UpdateExpression: 'SET currentCode = :code',
            ExpressionAttributeValues: { ':code': code }
          }).promise();
        }
      } catch (error) {
        console.error('Error handling code update:', error);
      }
    });
    
    // Teacher updates current slide
    socket.on('update-slide', async (data) => {
      try {
        const { slideIndex } = data;
        const sessionCode = socket.data?.sessionCode;
        
        if (!sessionCode || !socket.data.isTeacher) {
          socket.emit('error', { message: 'Not authorized to change slides' });
          return;
        }
        
        // Update slide in database using direct DB call (simpler for socket context)
        await docClient.update({
          TableName: SESSIONS_TABLE,
          Key: { sessionCode },
          UpdateExpression: 'SET currentSlide = :slide, updatedAt = :updatedAt',
          ExpressionAttributeValues: {
            ':slide': slideIndex,
            ':updatedAt': new Date().toISOString()
          }
        }).promise();
        
        // Broadcast slide change to all users in the session
        codeIO.to(sessionCode).emit('slide-change', {
          index: slideIndex,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error updating slide:', error);
        socket.emit('error', { message: 'Failed to update slide' });
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
      try {
        const { code, language } = data;
        const sessionCode = socket.data?.sessionCode;
        const name = socket.data?.name;
        
        if (!sessionCode || !name) {
          socket.emit('error', { message: 'Not in a session' });
          return;
        }
        
        // Execute code (supports JavaScript and Python)
        let result = 'Code execution not implemented for this language';
        let error = null;
        
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
            error = execError.message;
            result = `Error: ${error}`;
          }
        }

        // for python execution
        if (language === 'python') {
          try {
            // Create a unique filename for this execution
            const tempFile = path.join(tempDir, `${uuidv4()}.py`);
            
            // Write code to temp file
            fs.writeFileSync(tempFile, code);
            
            // Execute with timeout
            const { stdout, stderr } = await execPromise(`python ${tempFile}`, { timeout: 5000 });
            result = stdout;
            if (stderr) error = stderr;
            
            // Clean up
            try {
              fs.unlinkSync(tempFile);
            } catch (cleanupError) {
              console.warn('Failed to delete temp file:', cleanupError);
            }
          } catch (execError) {
            error = execError.message;
            result = `Error: ${error}`;
          }
        }
        
        // Store execution result
        await docClient.update({
          TableName: SESSIONS_TABLE,
          Key: { sessionCode },
          UpdateExpression: 'SET students.#name.lastExecution = :exec',
          ExpressionAttributeNames: { '#name': name },
          ExpressionAttributeValues: { 
            ':exec': {
              result,
              error,
              timestamp: new Date().toISOString()
            }
          }
        }).promise();
        
        // Send result to the student who executed the code
        socket.emit('execution-result', {
          result,
          error,
          timestamp: new Date().toISOString()
        });
        
        // If this is a student, also send to teacher
        if (!socket.data.isTeacher) {
          // Get teacher sockets in this session
          const teacherSockets = await codeIO.in(sessionCode).fetchSockets();
          const teachers = teacherSockets.filter(s => s.data?.isTeacher);
          
          // Send execution result to teachers
          teachers.forEach(teacher => {
            teacher.emit('student-execution-result', {
              studentName: name,
              result,
              error,
              timestamp: new Date().toISOString()
            });
          });
        }
      } catch (error) {
        console.error('Code execution error:', error);
        socket.emit('error', { message: 'Code execution failed' });
      }
    });
    
    // User leaves or disconnects
    socket.on('disconnect', async () => {
      try {
        const { sessionCode, name, isTeacher } = socket.data || {};
        console.log(`Socket disconnected: ${socket.id}, User: ${name || 'Unknown'}`);
        
        if (sessionCode && name) {
          // Notify others that user left
          socket.to(sessionCode).emit('user-left', {
            name,
            timestamp: new Date().toISOString()
          });
          
          // Special handling for teacher disconnect
          if (isTeacher) {
            // Check if this was the last teacher
            const remainingSockets = await codeIO.in(sessionCode).fetchSockets();
            const remainingTeachers = remainingSockets.filter(s => 
              s.data?.isTeacher && s.id !== socket.id
            );
            
            // If no teachers left, clear summary timer
            if (remainingTeachers.length === 0 && summaryTimers.has(sessionCode)) {
              clearInterval(summaryTimers.get(sessionCode));
              summaryTimers.delete(sessionCode);
            }
          } else {
            // Remove student from session if not teacher
            await docClient.update({
              TableName: SESSIONS_TABLE,
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
  
  /**
   * Update summaries for all students in a session
   * @param {string} sessionCode - The session code
   */
  async function updateStudentSummaries(sessionCode) {
    try {
      // Get session data
      const result = await docClient.get({
        TableName: SESSIONS_TABLE,
        Key: { sessionCode }
      }).promise();
      
      if (!result.Item || !result.Item.students) return;
      
      const task = result.Item.currentTask || 'Coding task';
      const students = result.Item.students;
      
      // Process each student
      for (const [studentName, studentData] of Object.entries(students)) {
        if (studentData.code) {
          try {
            // Generate new summary
            const summary = await generateCodeSummary(studentData.code, task);
            
            // Update in database
            await docClient.update({
              TableName: SESSIONS_TABLE,
              Key: { sessionCode },
              UpdateExpression: 'SET students.#name.summary = :summary',
              ExpressionAttributeNames: { '#name': studentName },
              ExpressionAttributeValues: { ':summary': summary }
            }).promise();
            
            // Broadcast to teachers
            const teacherSockets = await codeIO.in(sessionCode).fetchSockets();
            const teachers = teacherSockets.filter(s => s.data?.isTeacher);
            
            teachers.forEach(teacher => {
              teacher.emit('student-summary-update', {
                studentName,
                summary,
                timestamp: new Date().toISOString()
              });
            });
          } catch (error) {
            console.error(`Error updating summary for ${studentName}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error in updateStudentSummaries:', error);
    }
  }
  
  return codeIO;
};