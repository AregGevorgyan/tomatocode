const AWS = require('aws-sdk');
const { VM, VMScript } = require('vm2');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const path = require('path');
const sessionController = require('./sessionController');
const { configureDB } = require('./db');

// Convert exec to promise-based with timeout
const execPromise = (command, options = {}) => {
  return new Promise((resolve, reject) => {
    // Stronger security: Only allow python command with specific parameters
    if (!command.startsWith('python ') && !command.startsWith('python3 ')) {
      return reject(new Error('Only Python execution is allowed'));
    }
    
    const process = exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    
    // Handle timeout - prevent long-running processes
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

// Import AI summary functionality - fix the module name spelling
let evaluateSubmission;
try {
  // Fixed: Correct module name spelling
  const AISummary = require('./AIsummary');
  evaluateSubmission = AISummary.evaluateSubmission;
} catch (error) {
  console.warn('AI summary module issue:', error.message);
  evaluateSubmission = async (code, task) => ({ 
    progress: "unknown",
    feedback: "No summary available - AI module not loaded correctly"
  });
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
  
  // Create temp directory if it doesn't exist with secure permissions
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { mode: 0o700 }); // Secure permissions
  }
  
  // Clean up any existing temp files at startup
  try {
    const files = fs.readdirSync(tempDir);
    files.forEach(file => {
      if (file.endsWith('.py')) {
        try {
          fs.unlinkSync(path.join(tempDir, file));
        } catch (err) {
          console.warn(`Could not delete temp file ${file}:`, err);
        }
      }
    });
  } catch (error) {
    console.error('Error cleaning temp directory:', error);
  }
  
  codeIO.on('connection', (socket) => {
    console.log(`New code socket connected: ${socket.id}`);
    
    // Set a timeout to disconnect idle sockets
    const activityTimeout = setTimeout(() => {
      socket.disconnect(true);
    }, 3600000); // 1 hour
    
    // Function to reset the activity timeout
    const resetTimeout = () => {
      clearTimeout(activityTimeout);
      socket.data.lastActive = new Date().toISOString();
      socket.data.activityTimeout = setTimeout(() => {
        socket.disconnect(true);
      }, 3600000); // 1 hour
    };
    
    // Keep track of the socket's activity
    socket.use((_packet, next) => {
      resetTimeout();
      next();
    });
    
    // User joins a coding session with session code
    socket.on('join-session', async ({ sessionCode, name }) => {
      try {
        // Input validation
        if (!sessionCode || typeof sessionCode !== 'string' || !name || typeof name !== 'string') {
          socket.emit('error', { message: 'Invalid session code or name format' });
          return;
        }
        
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
          isTeacher: false, // Students join via session code
          lastActive: new Date().toISOString()
        };
        
        // Add student to session directly using controller's method
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
        // Input validation
        if (!sessionCode || typeof sessionCode !== 'string' || !name || typeof name !== 'string') {
          socket.emit('error', { message: 'Invalid session code or name format' });
          return;
        }
        
        // Join the socket room
        socket.join(sessionCode);
        
        // Mark this socket as the teacher
        socket.data = { 
          name, 
          sessionCode, 
          isTeacher: true,
          lastActive: new Date().toISOString()
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
        // Input validation
        if (!data || typeof data !== 'object' || typeof data.code !== 'string') {
          socket.emit('error', { message: 'Invalid code data format' });
          return;
        }
        
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
              const summary = await evaluateSubmission(task, code);
              
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
        // Input validation
        if (!data || typeof data !== 'object' || typeof data.slideIndex !== 'number') {
          socket.emit('error', { message: 'Invalid slide data format' });
          return;
        }
        
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
      // Input validation
      if (!data || typeof data !== 'object' || !data.position) {
        return;
      }
      
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
        // Input validation
        if (!data || typeof data !== 'object' || 
            typeof data.code !== 'string' || 
            typeof data.language !== 'string') {
          socket.emit('error', { message: 'Invalid code execution data format' });
          return;
        }
        
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
        
        if (language.toLowerCase() === 'javascript') {
          try {
            // Using VM2 for safer execution with improved sandbox security
            const vm = new VM({
              timeout: 2000,
              sandbox: {},
              eval: false,
              wasm: false,
              fixAsync: true,
              console: 'redirect'
            });
            
            // Add safe console methods to the sandbox
            let consoleOutput = '';
            vm.on('console.log', (...args) => {
              consoleOutput += args.map(String).join(' ') + '\n';
            });
            
            // Prevent access to dangerous globals
            const script = new VMScript(`
              (function() { 
                "use strict";
                const process = undefined;
                const require = undefined;
                const module = undefined;
                const exports = undefined;
                const __dirname = undefined;
                const __filename = undefined;
                const setTimeout = undefined;
                const setInterval = undefined;
                
                ${code}
                
                return { result: eval("(" + ${JSON.stringify(code)} + ")"), consoleOutput };
              })()
            `);
            
            const output = vm.run(script);
            result = consoleOutput;
            
            if (output && output.result !== undefined) {
              result += "\n=> " + String(output.result);
            }
          } catch (execError) {
            error = execError.message;
            result = `Error: ${error}`;
          }
        }

        // for python execution with improved security
        if (language.toLowerCase() === 'python') {
          try {
            // Create a unique filename for this execution
            const tempFile = path.join(tempDir, `${uuidv4()}.py`);
            
            // Set secure permissions
            fs.writeFileSync(tempFile, code, { mode: 0o600 });
            
            // Execute with timeout and resource limits
            // Use Python's resource module to limit memory and CPU
            const limitedCode = `
import resource, sys, os

# Set resource limits
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))  # 2 seconds of CPU time
resource.setrlimit(resource.RLIMIT_DATA, (50 * 1024 * 1024, 50 * 1024 * 1024))  # 50MB memory

# Disable potentially dangerous modules
sys.modules['os'].__dict__['system'] = None
sys.modules['os'].__dict__['popen'] = None
sys.modules['subprocess'] = None

# Your code below
${code}
`;
            
            // Write the limited code to file
            fs.writeFileSync(tempFile, limitedCode);
            
            // Execute with timeout
            const { stdout, stderr } = await execPromise(`python ${tempFile}`, { 
              timeout: 5000,
              maxBuffer: 1024 * 1024 // 1MB output limit
            });
            
            result = stdout;
            if (stderr) error = stderr;
            
            // Clean up immediately
            try {
              fs.unlinkSync(tempFile);
            } catch (cleanupError) {
              console.warn('Failed to delete temp file:', cleanupError);
            }
          } catch (execError) {
            error = execError.message;
            result = `Error: ${error}`;
            
            // Ensure temp file is cleaned up even on error
            try {
              if (tempFile && fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
              }
            } catch (cleanupError) {
              console.warn('Failed to delete temp file on error:', cleanupError);
            }
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
        // Clear the activity timeout
        if (socket.data && socket.data.activityTimeout) {
          clearTimeout(socket.data.activityTimeout);
        }
        
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
            // Note: Fixed order of parameters (task first, code second)
            const summary = await evaluateSubmission(task, studentData.code);
            
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
  
  // Clean up temp files periodically
  setInterval(() => {
    try {
      const files = fs.readdirSync(tempDir);
      const now = Date.now();
      
      files.forEach(file => {
        if (file.endsWith('.py')) {
          const filePath = path.join(tempDir, file);
          try {
            const stats = fs.statSync(filePath);
            // Delete files older than 15 minutes
            if (now - stats.mtimeMs > 15 * 60 * 1000) {
              fs.unlinkSync(filePath);
            }
          } catch (err) {
            console.warn(`Could not process temp file ${file}:`, err);
          }
        }
      });
    } catch (error) {
      console.error('Error cleaning temp directory:', error);
    }
  }, 15 * 60 * 1000); // Run every 15 minutes
  
  return codeIO;
};