const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { VM, VMScript } = require('vm2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
require('dotenv').config();

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

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"]
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e8
});

// Middleware
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------
// IN-MEMORY DATABASE REPLACEMENT
// ------------------------------------------------------------
const inMemoryDB = {
  sessions: new Map(), // sessionCode -> session data
};

// Create temp directory with secure permissions
const tempDir = path.join(__dirname, 'temp');
try {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { mode: 0o700 }); // Secure permissions
  }
} catch (error) {
  console.error('Could not create temp directory:', error);
  process.exit(1);
}

// ------------------------------------------------------------
// HELPER FUNCTIONS
// ------------------------------------------------------------

/**
 * Generates a random string of lowercase letters of given length.
 * @param {number} length - Number of characters.
 * @returns {string} - Random lowercase string.
 */
const generateSessionCode = (length = 6) => {
  let result = '';
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
};

/**
 * Generate a unique session code that doesn't exist in the database
 * @returns {Promise<string>} Unique session code
 */
const generateUniqueSessionCode = async () => {
  let code;
  let exists = true;
  do {
    code = generateSessionCode();
    exists = inMemoryDB.sessions.has(code);
  } while (exists);
  return code;
};

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

// Generate code summary with rate limiting
const summaryRateLimiter = new Map();
const generateCodeSummary = async (task, code, sessionCode, studentName) => {
  // Create a rate-limiting key for this student
  const rateKey = `${sessionCode}:${studentName}`;
  const now = Date.now();
  
  // Check if we've generated a summary recently for this student
  if (summaryRateLimiter.has(rateKey)) {
    const lastTime = summaryRateLimiter.get(rateKey);
    
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

// Check if slide has coding assignments
function isSlideWithCoding(session, slideIndex) {
  // Check if the session has slide data directly
  if (session.slides && Array.isArray(session.slides) && session.slides[slideIndex]) {
    return !!session.slides[slideIndex].hasCodingTask;
  }
  
  // Default to false for sessions without slide metadata
  return false;
}

// ------------------------------------------------------------
// SESSION CONTROLLER FUNCTIONS
// ------------------------------------------------------------

/**
 * Create a new session.
 * @route POST /api/sessions/create
 */
const createSession = async (req, res) => {
  try {
    const { title, description, language, initialCode, slides, presentationId, embedUrl } = req.body;

    // Generate a unique session code (6 lowercase letters)
    const sessionCode = await generateUniqueSessionCode();

    // Prepare session data
    const sessionData = {
      sessionCode,
      title: title || 'Coding Session',
      description: description || 'Interactive coding session',
      language: language || 'javascript',
      initialCode: initialCode || '',
      currentCode: initialCode || '',
      slides: slides || [],
      currentSlide: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      students: {},
      active: true,
      presentationId,
      embedUrl
    };

    // Store in memory
    inMemoryDB.sessions.set(sessionCode, sessionData);

    // Send success response
    res.status(201).json({
      success: true,
      sessionCode,
      message: 'Session created successfully'
    });
  } catch (error) {
    console.error('Create Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create session',
      error: error.message
    });
  }
};

/**
 * Get session by code
 * @route GET /api/sessions/:sessionCode
 */
const getSessionByCode = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const session = inMemoryDB.sessions.get(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    res.status(200).json({
      success: true,
      session
    });
  } catch (error) {
    console.error('Get Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve session',
      error: error.message
    });
  }
};

/**
 * Update session information
 * @route PUT /api/sessions/:sessionCode
 */
const updateSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const updates = req.body;
    
    const session = inMemoryDB.sessions.get(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Apply updates
    Object.entries(updates).forEach(([key, value]) => {
      if (!['sessionCode', 'createdAt'].includes(key)) {
        session[key] = value;
      }
    });
    
    session.updatedAt = new Date().toISOString();
    inMemoryDB.sessions.set(sessionCode, session);
    
    res.status(200).json({
      success: true,
      message: 'Session updated successfully'
    });
  } catch (error) {
    console.error('Update Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update session',
      error: error.message
    });
  }
};

/**
 * Delete session
 * @route DELETE /api/sessions/:sessionCode
 */
const deleteSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    
    if (!inMemoryDB.sessions.has(sessionCode)) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    inMemoryDB.sessions.delete(sessionCode);
    
    res.status(200).json({
      success: true,
      message: 'Session deleted successfully'
    });
  } catch (error) {
    console.error('Delete Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete session',
      error: error.message
    });
  }
};

/**
 * Join an existing session as a student
 * @route POST /api/sessions/:sessionCode/join
 */
const joinSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    const { studentName } = req.body;
    
    if (!studentName) {
      return res.status(400).json({
        success: false,
        message: 'Student name is required'
      });
    }

    const session = inMemoryDB.sessions.get(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    if (!session.active) {
      return res.status(400).json({
        success: false,
        message: 'This session is no longer active'
      });
    }
    
    // Add student to session
    if (!session.students) session.students = {};
    
    session.students[studentName] = {
      joinedAt: new Date().toISOString(),
      code: '',
      lastActive: new Date().toISOString()
    };
    
    inMemoryDB.sessions.set(sessionCode, session);
    
    res.status(200).json({
      success: true,
      message: 'Joined session successfully',
      session
    });
  } catch (error) {
    console.error('Join Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to join session',
      error: error.message
    });
  }
};

/**
 * End an active session
 * @route PUT /api/sessions/:sessionCode/end
 */
const endSession = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    
    const session = inMemoryDB.sessions.get(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    session.active = false;
    session.updatedAt = new Date().toISOString();
    inMemoryDB.sessions.set(sessionCode, session);
    
    res.status(200).json({
      success: true,
      message: 'Session ended successfully'
    });
  } catch (error) {
    console.error('End Session Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to end session',
      error: error.message
    });
  }
};

/**
 * Update current slide for a session
 * @route PUT /api/sessions/:sessionCode/slide/:slideIndex
 */
const updateCurrentSlide = async (req, res) => {
  try {
    const { sessionCode, slideIndex } = req.params;
    const slideNum = parseInt(slideIndex, 10);
    
    if (isNaN(slideNum) || slideNum < 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid slide index'
      });
    }
    
    const session = inMemoryDB.sessions.get(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    session.currentSlide = slideNum;
    session.updatedAt = new Date().toISOString();
    inMemoryDB.sessions.set(sessionCode, session);
    
    res.status(200).json({
      success: true,
      message: 'Current slide updated successfully'
    });
  } catch (error) {
    console.error('Update Slide Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update current slide',
      error: error.message
    });
  }
};

/**
 * Update student code in a session
 * @param {string} sessionCode - Session code
 * @param {string} studentName - Student name
 * @param {string} code - Student's code
 * @returns {Promise<boolean>} Success status
 */
const updateStudentCode = async (sessionCode, studentName, code) => {
  try {
    const session = inMemoryDB.sessions.get(sessionCode);
    
    if (!session || !session.students || !session.students[studentName]) {
      return false;
    }
    
    session.students[studentName].code = code;
    session.students[studentName].lastActive = new Date().toISOString();
    inMemoryDB.sessions.set(sessionCode, session);
    
    return true;
  } catch (error) {
    console.error('Error updating student code:', error);
    return false;
  }
};

/**
 * Get all code summaries for a session
 * @route GET /api/sessions/:sessionCode/summaries
 */
const getSessionSummaries = async (req, res) => {
  try {
    const { sessionCode } = req.params;
    
    const session = inMemoryDB.sessions.get(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Extract summaries from students
    const summaries = [];
    if (session.students) {
      Object.entries(session.students).forEach(([studentName, data]) => {
        if (data.summary) {
          summaries.push({
            studentName,
            ...data.summary,
            timestamp: data.lastActive
          });
        }
      });
    }
    
    res.status(200).json({
      success: true,
      summaries
    });
  } catch (error) {
    console.error('Error fetching session summaries:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve session summaries',
      error: error.message
    });
  }
};

/**
 * Get summaries for a specific student in a session
 * @route GET /api/sessions/:sessionCode/students/:studentName/summaries
 */
const getStudentSummaries = async (req, res) => {
  try {
    const { sessionCode, studentName } = req.params;
    
    const session = inMemoryDB.sessions.get(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    if (!session.students || !session.students[studentName]) {
      return res.status(404).json({
        success: false,
        message: 'Student not found in this session'
      });
    }
    
    const summary = session.students[studentName].summary || null;
    
    res.status(200).json({
      success: true,
      summaries: summary ? [summary] : []
    });
  } catch (error) {
    console.error('Error fetching student summaries:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve student summaries',
      error: error.message
    });
  }
};

// ------------------------------------------------------------
// SETUP ROUTES
// ------------------------------------------------------------

// Session routes
app.post('/api/sessions/create', createSession);
app.get('/api/sessions/:sessionCode', getSessionByCode);
app.put('/api/sessions/:sessionCode', updateSession);
app.delete('/api/sessions/:sessionCode', deleteSession);
app.post('/api/sessions/:sessionCode/join', joinSession);
app.put('/api/sessions/:sessionCode/end', endSession);
app.put('/api/sessions/:sessionCode/slide/:slideIndex', updateCurrentSlide);
app.get('/api/sessions/:sessionCode/summaries', getSessionSummaries);
app.get('/api/sessions/:sessionCode/students/:studentName/summaries', getStudentSummaries);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Server is running');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'production' ? null : err.message
  });
});

// Handle 404 routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// ------------------------------------------------------------
// SOCKET.IO SETUP
// ------------------------------------------------------------

// Namespace for coding sessions
const codeIO = io.of('/code');

// Track periodic summary updates
const summaryTimers = new Map();

// Track session info for reconnection
const sessionInfo = new Map();
// changed form codeio
codeIO.on('connection', (socket) => {
  console.log(`New code socket connected: ${socket.id}`);
  
  // Use a timeout (30 minutes)
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
      const session = inMemoryDB.sessions.get(sessionCode);
      
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
      if (session.students[name]) {
        session.students[name].socketId = socket.id;
        session.students[name].lastActive = new Date().toISOString();
        inMemoryDB.sessions.set(sessionCode, session);
      }
      
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
      const session = inMemoryDB.sessions.get(sessionCode);
      
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
          hasCodeEditors: true,
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
      if (!session.students) session.students = {};
      
      session.students[name] = {
        joinedAt: new Date().toISOString(),
        code: '',
        socketId: socket.id,
        lastActive: new Date().toISOString(),
        reconnectToken: socket.data.reconnectToken
      };
      
      inMemoryDB.sessions.set(sessionCode, session);
      
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
        info.studentCount = Object.keys(session.students || {}).length;
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
      
      // Verify session exists and fetch data
      const session = inMemoryDB.sessions.get(sessionCode);
      if (!session) {
        socket.emit('error', { message: 'Invalid session code' });
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
      
      // Send session data to teacher
      socket.emit('session-data', session);
      
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
      session.teacherSocketId = socket.id;
      inMemoryDB.sessions.set(sessionCode, session);
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
      
      const session = inMemoryDB.sessions.get(sessionCode);
      if (!session) return;
      
      // Update slides info in database
      session.slides = data.slides || [];
      inMemoryDB.sessions.set(sessionCode, session);
      
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
      
      const session = inMemoryDB.sessions.get(sessionCode);
      if (!session) return;
      
      // Handle student code updates
      if (!socket.data.isTeacher) {
        // Update student code
        await updateStudentCode(sessionCode, name, code);
        
        // Get teacher sockets in this session CHANGED 
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
            // Get current task description from the current slide
            let task = "Coding task";
            
            if (session.slides && 
                session.currentSlide !== undefined && 
                session.slides[session.currentSlide]) {
              task = session.slides[session.currentSlide].prompt || task;
            }
            
            // Generate AI summary with rate limiting
            const summary = await generateCodeSummary(task, code, sessionCode, name);
            
            // If summary was generated (not rate limited), update and notify teachers
            if (summary) {
              if (!session.students[name]) session.students[name] = {};
              session.students[name].summary = summary;
              inMemoryDB.sessions.set(sessionCode, session);
              
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
        session.currentCode = code;
        inMemoryDB.sessions.set(sessionCode, session);
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
      
      const session = inMemoryDB.sessions.get(sessionCode);
      if (!session) return;
      
      // Update slide
      session.currentSlide = slideIndex;
      session.updatedAt = new Date().toISOString();
      inMemoryDB.sessions.set(sessionCode, session);
      
      // Check if this slide has a coding assignment
      const hasCodeEditor = isSlideWithCoding(session, slideIndex);
      
      // Get slide prompt if available
      let slidePrompt = '';
      if (session.slides && session.slides[slideIndex]) {
        slidePrompt = session.slides[slideIndex].prompt || '';
      }
      // chaged form codeio
      // Broadcast slide change to all users with info about whether this slide has coding
      codeIO.to(sessionCode).emit('slide-change', {
        index: slideIndex,
        timestamp: new Date().toISOString(),
        hasCodeEditor,
        prompt: slidePrompt
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
          // Clean up the temp file
          try {
            if (fs.existsSync(tempFile)) {
              fs.unlinkSync(tempFile);
            }
          } catch (cleanupError) {
            console.warn('Failed to delete temp file:', cleanupError);
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
      const session = inMemoryDB.sessions.get(sessionCode);
      if (session && session.students && session.students[name]) {
        session.students[name].lastExecution = {
          result,
          error,
          timestamp: new Date().toISOString()
        };
        inMemoryDB.sessions.set(sessionCode, session);
      }
      
      // Send result to the student who executed the code
      socket.emit('execution-result', {
        result,
        error,
        timestamp: new Date().toISOString()
      });
      
      // Send to teacher if from student
      if (!socket.data.isTeacher) {//changed 
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
        if (isTeacher) {//changed
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
          // Mark student as disconnected
          const session = inMemoryDB.sessions.get(sessionCode);
          if (session && session.students && session.students[name]) {
            session.students[name].disconnectedAt = new Date().toISOString();
            inMemoryDB.sessions.set(sessionCode, session);
            
            // Schedule removal after 5 minutes if no reconnection
            setTimeout(async () => {
              try {
                // Check if student has reconnected
                const currentSession = inMemoryDB.sessions.get(sessionCode);
                if (currentSession?.students?.[name]?.disconnectedAt &&
                    !currentSession?.students?.[name]?.reconnectedAt) {
                  // Remove student if still disconnected
                  delete currentSession.students[name];
                  inMemoryDB.sessions.set(sessionCode, currentSession);
                  console.log(`Student ${name} removed after disconnect timeout`);
                }
              } catch (error) {
                console.error('Error handling student cleanup:', error);
              }
            }, 5 * 60 * 1000); // 5 minutes
          }
        }
      }
    } catch (error) {
      console.error('Error handling disconnection:', error);
    }
  });
});

// Update summaries for all students in a session
async function updateStudentSummaries(sessionCode) {
  try {
    // Get session data
    const session = inMemoryDB.sessions.get(sessionCode);
    
    if (!session || !session.students) return;
    
    // Get the task from the current slide
    let task = "Coding task";
    if (session.slides && 
        session.currentSlide !== undefined && 
        session.slides[session.currentSlide]) {
      task = session.slides[session.currentSlide].prompt || task;
    }
    
    const students = session.students;
    
    // Limit the number of simultaneous AI calls
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
        
        // Update in-memory database
        students[studentName].summary = summary;
        //changed
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
    
    // Save updated session with summaries
    inMemoryDB.sessions.set(sessionCode, session);
  } catch (error) {
    console.error('Error in updateStudentSummaries:', error);
  }
}

// ------------------------------------------------------------
// SERVER INITIALIZATION
// ------------------------------------------------------------

// Clean temp files at startup and periodically
secureCleanTempFiles();
const cleanupInterval = setInterval(secureCleanTempFiles, 15 * 60 * 1000);

// Initialize server
const PORT = process.env.PORT || 3000;
const startServer = async () => {
  try {
    // Start server
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// For graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  clearInterval(cleanupInterval);
  
  // Clear all timers
  for (const timer of summaryTimers.values()) {
    clearInterval(timer);
  }
  summaryTimers.clear();
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server }; // Export for testing