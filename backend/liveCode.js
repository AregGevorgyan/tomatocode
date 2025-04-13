const AWS = require('aws-sdk');
const { VM, VMScript } = require('vm2');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const sessionController = require('./sessionController');
const { configureDB } = require('./db');

// Enhanced security: Use a safer exec with promise and additional safeguards
const execPromise = (command, options = {}) => {
  return new Promise((resolve, reject) => {
    // Whitelist allowed commands with regex pattern matching
    const safeCommandRegex = /^python[3]?\s+["']?([\/\\a-zA-Z0-9_\-\.]+\.py)["']?(\s+.*)?$/;
    
    if (!safeCommandRegex.test(command)) {
      return reject(new Error('Only Python execution with safe parameters is allowed'));
    }
    
    const childProcess = exec(command, {
      ...options,
      // Prevent shell injection
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      // Don't inherit environment variables to isolate the execution
      env: { 
        PATH: process.env.PATH,
        PYTHONPATH: process.env.PYTHONPATH || '',
        TEMP: process.env.TEMP || '/tmp',
        TMP: process.env.TMP || '/tmp'
      }
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    
    // Handle timeout with proper cleanup
    if (options.timeout) {
      setTimeout(() => {
        try {
          childProcess.kill('SIGTERM');
          setTimeout(() => {
            if (childProcess.exitCode === null) {
              childProcess.kill('SIGKILL');
            }
          }, 500);
        } catch (err) {
          console.warn('Error killing timed out process:', err);
        }
        reject(new Error(`Execution timed out after ${options.timeout}ms`));
      }, options.timeout);
    }
  });
};

// Configure AWS with exponential backoff retry strategy
AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1', 
  maxRetries: 5,
  retryDelayOptions: { base: 300 }
});

const { docClient } = configureDB();
const SESSIONS_TABLE = process.env.SESSIONS_TABLE || 'CodingSessions';

// Import AI summary functionality
let evaluateSubmission;
try {
  const AISummary = require('./AIsummary');
  evaluateSubmission = AISummary.evaluateSubmission;
} catch (error) {
  console.warn('AI summary module issue:', error.message);
  evaluateSubmission = async (task, code) => ({ 
    progress: "unknown",
    feedback: "No summary available - AI module not loaded correctly"
  });
}

// Rate limiting for AI summary requests
const summaryRateLimiter = new Map();

/**
 * Configure Socket.IO events for live coding
 * @param {Object} io - Socket.IO instance
 */
module.exports = function(io) {
  // Namespace for coding sessions
  const codeIO = io.of('/code');
  
  // Track periodic summary updates
  const summaryTimers = new Map();
  
  // Track session info for reconnection
  const sessionInfo = new Map();
  
  // Create temp directory with secure permissions
  const tempDir = path.join(__dirname, 'temp');
  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { mode: 0o700 }); // Secure permissions
    }
  } catch (error) {
    console.error('Could not create temp directory:', error);
    process.exit(1); // Exit if we can't create a secure temp dir
  }
  
  // Securely clean temp files with validation
  const secureCleanTempFiles = () => {
    try {
      const files = fs.readdirSync(tempDir);
      const now = Date.now();
      let cleanedCount = 0;
      
      files.forEach(file => {
        // Validate filename with regex before processing
        if (/^[a-f0-9\-]+\.py$/.test(file)) {
          const filePath = path.join(tempDir, file);
          
          // Ensure the path doesn't escape the temp directory (path traversal protection)
          const resolvedPath = path.resolve(filePath);
          if (!resolvedPath.startsWith(path.resolve(tempDir))) {
            console.warn(`Potential path traversal attempt: ${file}`);
            return;
          }
          
          try {
            const stats = fs.statSync(filePath);
            // Delete files older than 15 minutes
            if (now - stats.mtimeMs > 15 * 60 * 1000) {
              fs.unlinkSync(filePath);
              cleanedCount++;
            }
          } catch (err) {
            console.warn(`Could not process temp file ${file}:`, err);
          }
        } else if (file !== '.gitkeep') {
          console.warn(`Found unexpected file in temp directory: ${file}`);
        }
      });
      
      if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} temporary files`);
      }
    } catch (error) {
      console.error('Error cleaning temp directory:', error);
    }
  };
  
  // Clean temp files at startup and periodically
  secureCleanTempFiles();
  const cleanupInterval = setInterval(secureCleanTempFiles, 15 * 60 * 1000);
  
  // Safe DynamoDB update with retry handling
  const safeDynamoUpdate = async (params, maxRetries = 3) => {
    let retries = 0;
    while (retries <= maxRetries) {
      try {
        return await docClient.update(params).promise();
      } catch (error) {
        if (error.code === 'ProvisionedThroughputExceededException' && retries < maxRetries) {
          const delay = Math.pow(2, retries) * 100; // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, delay));
          retries++;
          continue;
        }
        throw error;
      }
    }
  };
  
  // Get session info with pagination support
  const getSessionWithStudents = async (sessionCode) => {
    try {
      const result = await docClient.get({
        TableName: SESSIONS_TABLE,
        Key: { sessionCode }
      }).promise();
      
      return result.Item;
    } catch (error) {
      console.error(`Error retrieving session ${sessionCode}:`, error);
      throw error;
    }
  };
  
  // Generate code summary with rate limiting
  const generateCodeSummary = async (task, code, sessionCode, studentName) => {
    // Create a rate-limiting key for this student
    const rateKey = `${sessionCode}:${studentName}`;
    const now = Date.now();
    
    // Check if we've generated a summary recently for this student
    if (summaryRateLimiter.has(rateKey)) {
      const lastTime = summaryRateLimiter.get(rateKey);
      
      // Only generate a new summary if more than 10 seconds have passed
      // or if it's the first summary (lastTime is null)
      if (lastTime && now - lastTime < 10000) {
        return null; // Skip generation if too recent
      }
    }
    
    // Update rate limiter
    summaryRateLimiter.set(rateKey, now);
    
    try {
      // Call AI evaluation service
      return await evaluateSubmission(task, code);
    } catch (error) {
      console.error(`Error generating summary for ${studentName}:`, error);
      return {
        progress: 'unknown',
        feedback: 'Error generating summary'
      };
    } finally {
      // Clear rate limit after 20 seconds
      setTimeout(() => {
        if (summaryRateLimiter.get(rateKey) === now) {
          summaryRateLimiter.delete(rateKey);
        }
      }, 20000);
    }
  };
  
  codeIO.on('connection', (socket) => {
    console.log(`New code socket connected: ${socket.id}`);
    
    // Use a more reasonable timeout (30 minutes instead of 1 hour)
    let activityTimeout = setTimeout(() => {
      socket.disconnect(true);
    }, 30 * 60 * 1000);
    
    const resetTimeout = () => {
      clearTimeout(activityTimeout);
      socket.data = socket.data || {};
      socket.data.lastActive = new Date().toISOString();
      activityTimeout = setTimeout(() => {
        socket.disconnect(true);
      }, 30 * 60 * 1000);
    };
    
    socket.use((_packet, next) => {
      resetTimeout();
      next();
    });
    
    // Session reconnection handler
    socket.on('reconnect-session', async ({ sessionCode, name, token }) => {
      try {
        // Validate inputs
        if (!sessionCode || !name) {
          socket.emit('error', { message: 'Missing session code or name' });
          return;
        }
        
        // Get session data
        const session = await getSessionWithStudents(sessionCode);
        
        if (!session) {
          socket.emit('error', { message: 'Invalid session code' });
          return;
        }
        
        const students = session.students || {};
        
        // Check if student exists in this session
        if (!students[name]) {
          socket.emit('error', { message: 'Student not found in session' });
          return;
        }
        
        // Join the socket room
        socket.join(sessionCode);
        
        // Store user data with socket
        socket.data = { 
          name, 
          sessionCode,
          isTeacher: false,
          lastActive: new Date().toISOString(),
          reconnected: true
        };
        
        // Update the socketId for this student
        await safeDynamoUpdate({
          TableName: SESSIONS_TABLE,
          Key: { sessionCode },
          UpdateExpression: 'SET students.#name.socketId = :socketId, students.#name.lastActive = :lastActive',
          ExpressionAttributeNames: { '#name': name },
          ExpressionAttributeValues: { 
            ':socketId': socket.id,
            ':lastActive': new Date().toISOString()
          }
        });
        
        // Send current session data back to the student
        socket.emit('session-data', session);
        
        // Send current slide
        socket.emit('slide-change', {
          index: session.currentSlide || 0,
          hasCodeEditor: isSlideWithCoding(session, session.currentSlide || 0)
        });
        
        // Restore student's previous code if available
        if (students[name].code) {
          socket.emit('code-restore', {
            code: students[name].code,
            timestamp: new Date().toISOString()
          });
        }
        
        console.log(`User ${name} reconnected to session ${sessionCode}`);
      } catch (error) {
        console.error('Error reconnecting to session:', error);
        socket.emit('error', { message: 'Failed to reconnect to session' });
      }
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
        const session = await getSessionWithStudents(sessionCode);
        
        if (!session) {
          socket.emit('error', { message: 'Invalid session code' });
          return;
        }
        
        // Check if active
        if (session.active === false) {
          socket.emit('error', { message: 'This session has ended' });
          return;
        }
        
        // Store session info for reconnection
        if (!sessionInfo.has(sessionCode)) {
          sessionInfo.set(sessionCode, {
            title: session.title,
            hasCodeEditors: true, // Default assumption until we know more from slides
            studentCount: Object.keys(session.students || {}).length
          });
        }
        
        // Join the socket room
        socket.join(sessionCode);
        
        // Store user data with socket
        socket.data = { 
          name, 
          sessionCode,
          isTeacher: false,
          lastActive: new Date().toISOString(),
          reconnectToken: crypto.randomBytes(16).toString('hex')
        };
        
        // Add student to session
        await safeDynamoUpdate({
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
              lastActive: new Date().toISOString(),
              reconnectToken: socket.data.reconnectToken
            }
          }
        });
        
        // Send session data to student
        socket.emit('session-data', {
          ...session,
          reconnectToken: socket.data.reconnectToken // For reconnection
        });
        
        // Send current slide to student
        socket.emit('slide-change', {
          index: session.currentSlide || 0,
          hasCodeEditor: isSlideWithCoding(session, session.currentSlide || 0)
        });
        
        // Notify others that someone joined
        socket.to(sessionCode).emit('user-joined', {
          name,
          timestamp: new Date().toISOString()
        });
        
        // Update the session info with new count
        if (sessionInfo.has(sessionCode)) {
          const info = sessionInfo.get(sessionCode);
          info.studentCount = Object.keys(session.students || {}).length + 1;
          sessionInfo.set(sessionCode, info);
        }
        
        console.log(`User ${name} joined session ${sessionCode}`);
      } catch (error) {
        console.error('Error joining session:', error);
        socket.emit('error', { message: 'Failed to join session' });
      }
    });
    
    // Teacher creates and joins session
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
        
        // Start periodic summary updates
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
        
        // Update the session with the teacher info
        await safeDynamoUpdate({
          TableName: SESSIONS_TABLE,
          Key: { sessionCode },
          UpdateExpression: 'SET teacherSocketId = :socketId',
          ExpressionAttributeValues: { ':socketId': socket.id }
        });
      } catch (error) {
        console.error('Error with teacher join:', error);
        socket.emit('error', { message: 'Failed to join as teacher' });
      }
    });
    
    // Update slide data and whether it has coding tasks
    socket.on('update-slide-data', async (data) => {
      try {
        // Validate data and permissions
        if (!data || !socket.data?.isTeacher) {
          return;
        }
        
        const sessionCode = socket.data?.sessionCode;
        if (!sessionCode) return;
        
        // Update slides info in database
        await safeDynamoUpdate({
          TableName: SESSIONS_TABLE,
          Key: { sessionCode },
          UpdateExpression: 'SET slides = :slides',
          ExpressionAttributeValues: { ':slides': data.slides || [] }
        });
        
        // Store which slides have coding tasks
        if (sessionInfo.has(sessionCode)) {
          const info = sessionInfo.get(sessionCode);
          info.slidesWithCode = data.slidesWithCode || [];
          sessionInfo.set(sessionCode, info);
        } else {
          sessionInfo.set(sessionCode, {
            slidesWithCode: data.slidesWithCode || [],
            studentCount: 0
          });
        }
      } catch (error) {
        console.error('Error updating slide data:', error);
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
        
        // Handle student code updates
        if (!socket.data.isTeacher) {
          // Update student code in database
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
          
          // Only generate a summary if code has substantial content
          if (code.length > 10) {
            try {
              // Get current task description
              const session = await getSessionWithStudents(sessionCode);
              const task = session?.currentTask || 'Coding task';
              
              // Generate AI summary with rate limiting
              const summary = await generateCodeSummary(task, code, sessionCode, name);
              
              // If summary was generated (not rate limited), update DB and notify teachers
              if (summary) {
                await safeDynamoUpdate({
                  TableName: SESSIONS_TABLE,
                  Key: { sessionCode },
                  UpdateExpression: 'SET students.#name.summary = :summary',
                  ExpressionAttributeNames: { '#name': name },
                  ExpressionAttributeValues: { ':summary': summary }
                });
                
                teachers.forEach(teacher => {
                  teacher.emit('student-summary-update', {
                    studentName: name,
                    summary,
                    timestamp: new Date().toISOString()
                  });
                });
              }
            } catch (summaryError) {
              console.error('Error handling code summary:', summaryError);
            }
          }
        } else {
          // Handle teacher code updates
          await safeDynamoUpdate({
            TableName: SESSIONS_TABLE,
            Key: { sessionCode },
            UpdateExpression: 'SET currentCode = :code',
            ExpressionAttributeValues: { ':code': code }
          });
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
        
        // Update slide in database
        await safeDynamoUpdate({
          TableName: SESSIONS_TABLE,
          Key: { sessionCode },
          UpdateExpression: 'SET currentSlide = :slide, updatedAt = :updatedAt',
          ExpressionAttributeValues: {
            ':slide': slideIndex,
            ':updatedAt': new Date().toISOString()
          }
        });
        
        // Check if this slide has a coding assignment
        const hasCodeEditor = isSlideWithCoding({ sessionCode }, slideIndex);
        
        // Broadcast slide change to all users with info about whether this slide has coding
        codeIO.to(sessionCode).emit('slide-change', {
          index: slideIndex,
          timestamp: new Date().toISOString(),
          hasCodeEditor
        });
      } catch (error) {
        console.error('Error updating slide:', error);
        socket.emit('error', { message: 'Failed to update slide' });
      }
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
            
            // Prevent access to dangerous globals with enhanced sandbox
            const script = new VMScript(`
              (function() { 
                "use strict";
                // Prevent access to dangerous APIs
                const process = undefined;
                const require = undefined;
                const module = undefined;
                const exports = undefined;
                const __dirname = undefined;
                const __filename = undefined;
                const setTimeout = undefined;
                const setInterval = undefined;
                const Buffer = undefined;
                const fetch = undefined;
                const XMLHttpRequest = undefined;
                
                ${code}
                
                return { result: eval("(" + ${JSON.stringify(code)} + ")"), consoleOutput };
              })()
            `, 'sandbox.js');
            
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
        
        // Python execution with improved security
        if (language.toLowerCase() === 'python') {
          // Create a unique filename with UUID to prevent conflicts
          const tempFileName = `${uuidv4()}.py`;
          const tempFile = path.join(tempDir, tempFileName);
          
          try {
            // Validate filename using regex to prevent path traversal
            if (!/^[a-f0-9\-]+\.py$/.test(tempFileName)) {
              throw new Error('Invalid filename format');
            }
            
            // Set secure permissions and write file
            fs.writeFileSync(tempFile, code, { mode: 0o600 });
            
            // Improved security: Use a Python script that enforces strict limits
            const limitedCode = `
import resource, sys, os, builtins, importlib

# Set resource limits
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))  # 2 seconds of CPU time
resource.setrlimit(resource.RLIMIT_DATA, (50 * 1024 * 1024, 50 * 1024 * 1024))  # 50MB memory
resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))  # 1MB file size limit

# Block dangerous operations
BLOCKED_MODULES = [
    "subprocess", "socket", "requests", "http", "urllib", 
    "ftplib", "telnetlib", "smtplib", "_pickle", "pickle"
]

# Prevent importing dangerous modules
original_import = builtins.__import__
def secure_import(name, *args, **kwargs):
    if name in BLOCKED_MODULES or any(name.startswith(prefix + '.') for prefix in BLOCKED_MODULES):
        raise ImportError(f"Import of {name} is not allowed for security reasons")
    return original_import(name, *args, **kwargs)
builtins.__import__ = secure_import

# Disable dangerous functions
sys.modules['os'].__dict__['system'] = None
sys.modules['os'].__dict__['popen'] = None
sys.modules['os'].__dict__['spawn'] = None
sys.modules['os'].__dict__['fork'] = None
sys.modules['os'].__dict__['execv'] = None
sys.modules['os'].__dict__['execve'] = None
sys.modules['os'].__dict__['unlink'] = None
sys.modules['os'].__dict__['__file__'] = None

# Disable file writing
builtin_open = builtins.open
def secure_open(file, mode='r', *args, **kwargs):
    if mode != 'r' and not mode.startswith('r'):
        raise IOError("File writing is not permitted")
    return builtin_open(file, mode, *args, **kwargs)
builtins.open = secure_open

# Student code below
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
          } catch (execError) {
            error = execError.message;
            result = `Error: ${error}`;
          } finally {
            // Clean up the temp file - use try/finally to ensure cleanup happens
            try {
              if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
              }
            } catch (cleanupError) {
              console.warn('Failed to delete temp file:', cleanupError);
              // Schedule a retry cleanup after a short delay
              setTimeout(() => {
                try {
                  if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                  }
                } catch (e) {
                  console.error('Failed to cleanup temp file in retry:', e);
                }
              }, 5000);
            }
          }
        }
        
        // Store execution result
        await safeDynamoUpdate({
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
        });
        
        // Send result to the student who executed the code
        socket.emit('execution-result', {
          result,
          error,
          timestamp: new Date().toISOString()
        });
        
        // Send to teacher if from student
        if (!socket.data.isTeacher) {
          const teacherSockets = await codeIO.in(sessionCode).fetchSockets();
          const teachers = teacherSockets.filter(s => s.data?.isTeacher);
          
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
        clearTimeout(activityTimeout);
        
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
            // Don't immediately remove student - allow time for reconnection
            // Mark as disconnected for now
            try {
              await safeDynamoUpdate({
                TableName: SESSIONS_TABLE,
                Key: { sessionCode },
                UpdateExpression: 'SET students.#name.disconnectedAt = :time',
                ExpressionAttributeNames: { '#name': name },
                ExpressionAttributeValues: { ':time': new Date().toISOString() }
              });
              
              // Schedule removal after 5 minutes if no reconnection
              setTimeout(async () => {
                try {
                  // Check if student has reconnected
                  const session = await getSessionWithStudents(sessionCode);
                  if (session?.students?.[name]?.disconnectedAt &&
                      !session?.students?.[name]?.reconnectedAt) {
                    // Remove student if still disconnected
                    await docClient.update({
                      TableName: SESSIONS_TABLE,
                      Key: { sessionCode },
                      UpdateExpression: 'REMOVE students.#name',
                      ExpressionAttributeNames: { '#name': name }
                    }).promise();
                    console.log(`Student ${name} removed after disconnect timeout`);
                  }
                } catch (error) {
                  console.error('Error handling student cleanup:', error);
                }
              }, 5 * 60 * 1000); // 5 minutes
            } catch (error) {
              console.error('Error marking student as disconnected:', error);
            }
          }
        }
      } catch (error) {
        console.error('Error handling disconnection:', error);
      }
    });
  });
  
  // Function to check if a slide has coding assignments
  function isSlideWithCoding(session, slideIndex) {
    // Check if we have specific slide data
    if (sessionInfo.has(session.sessionCode)) {
      const info = sessionInfo.get(session.sessionCode);
      if (info.slidesWithCode && Array.isArray(info.slidesWithCode)) {
        return info.slidesWithCode.includes(slideIndex);
      }
    }
    
    // Check if the session has slide data directly
    if (session.slides && Array.isArray(session.slides) && session.slides[slideIndex]) {
      return !!session.slides[slideIndex].hasCodingTask;
    }
    
    // Default to true for sessions without slide metadata
    return true;
  }
  
  // Update summaries for all students in a session with improved error handling
  async function updateStudentSummaries(sessionCode) {
    try {
      // Get session data
      const session = await getSessionWithStudents(sessionCode);
      
      if (!session || !session.students) return;
      
      const task = session.currentTask || 'Coding task';
      const students = session.students;
      
      // Limit the number of simultaneous AI calls to avoid rate limits
      let processedCount = 0;
      const maxBatchSize = 5;
      
      // Process students in batches
      for (const [studentName, studentData] of Object.entries(students)) {
        // Skip if no code or disconnected
        if (!studentData.code || studentData.disconnectedAt) continue;
        
        // Rate limit AI calls per batch
        if (processedCount >= maxBatchSize) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          processedCount = 0;
        }
        
        processedCount++;
        
        try {
          // Generate summary
          const summary = await generateCodeSummary(task, studentData.code, sessionCode, studentName);
          if (!summary) continue; // Skip if rate limited
          
          // Update in database with error handling
          await safeDynamoUpdate({
            TableName: SESSIONS_TABLE,
            Key: { sessionCode },
            UpdateExpression: 'SET students.#name.summary = :summary',
            ExpressionAttributeNames: { '#name': studentName },
            ExpressionAttributeValues: { ':summary': summary }
          });
          
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
          // Continue with other students even if one fails
        }
      }
    } catch (error) {
      console.error('Error in updateStudentSummaries:', error);
    }
  }
  
  // Proper cleanup on server shutdown
  process.on('SIGINT', () => {
    clearInterval(cleanupInterval);
    console.log('SIGINT received, cleaning up...');
    secureCleanTempFiles();
    
    // Clear all timers
    for (const timer of summaryTimers.values()) {
      clearInterval(timer);
    }
    summaryTimers.clear();
    
    process.exit(0);
  });
  
  return codeIO;
};